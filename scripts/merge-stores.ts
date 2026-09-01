#!/usr/bin/env node
/**
 * merge-stores - ONE-OFF migration merging every profile-scoped context-mode
 * store into the single global store, per project hash. See
 * docs/plan-store-unification.md (phase 2). Dry-run by default; pass
 * --apply to actually write.
 *
 * Lives under scripts/, not the CLI (src/cli.ts:191-224) - this is a
 * one-time job, not a permanent surface (see the plan's phase 2 note on
 * why this isn't a `migrate` subcommand).
 *
 * Usage:
 *   npx tsx scripts/merge-stores.ts             # dry run against the real stores
 *   npx tsx scripts/merge-stores.ts --apply     # perform the real merge
 *
 * SAFETY: every disk-touching function below takes `home`/`globalBase` as
 * explicit parameters - none of them call homedir()/resolveContextModeDataRoot()
 * themselves. Only main() (bottom of file, guarded so importing this module
 * never runs it) resolves the real paths. Tests call the exported functions
 * directly with synthetic fixture paths, so there is zero risk of a test
 * touching a real store.
 *
 * Enumeration mirrors adoptLargestLegacyDb (src/db-base.ts): the one-level
 * dotfile scan under `home` (catches arbitrary CLAUDE_CONFIG_DIR profile
 * names like .claude-ime) PLUS the two-level LEGACY_ADAPTER_HOME_SEGMENTS
 * entries (.config/opencode, .config/JetBrains, ...) it can't reach. Per the
 * dispatch scope, this does NOT additionally walk vscode-copilot's
 * project-relative `.github/context-mode/...` store or any config-dir-env
 * relocated store (CODEX_HOME, COPILOT_HOME, ...) - those are the two
 * "STILL OPEN" cases the plan defers, same as adoptLargestLegacyDb.
 *
 * IDEMPOTENCY DESIGN: session_events/session_meta/session_resume/sources/
 * chunks/vocabulary are all naturally idempotent once merged via dedupe or
 * latest-wins keys - reprocessing the same physical rows twice collapses to
 * the same result. tool_calls is the one exception: calls/bytes_returned are
 * blind counters, and SUM is not idempotent across repeated runs where the
 * destination file is itself one of the merge inputs (round 2 would sum
 * round 1's already-summed total right back into itself). To fix this
 * without re-deriving tool_calls from events (it isn't derivable - a single
 * tool call fans out into several heterogeneous session_events rows, not a
 * 1:1 mapping), every merged DB gets a tiny `_merge_manifest` table
 * recording which legacy source files (by resolved path) have already been
 * folded in. Each run computes `newLegacy` = legacy sources not yet in that
 * set; if empty, the group is already fully merged and the run touches
 * nothing (no temp file, no rename, destination mtime/size unchanged) -
 * this is what makes "run it twice, second run is a no-op" hold structurally
 * rather than by accident.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import { loadDatabase, applyWALPragmas, closeDB } from "../src/db-base.js";
import {
  LEGACY_ADAPTER_HOME_SEGMENTS,
  LEGACY_ADAPTER_APPDATA_SEGMENTS,
  resolveContextModeDataRoot,
} from "../src/session/data-root.js";
import { SessionDB } from "../src/session/db.js";
import { ContentStore } from "../src/store.js";

type Subdir = "sessions" | "content";
type Row = Record<string, any>;

// ─────────────────────────────────────────────────────────
// Enumeration (mirrors adoptLargestLegacyDb's candidate roots)
// ─────────────────────────────────────────────────────────

interface CandidateRoot {
  name: string;
  base: string; // <root>/context-mode
}

/**
 * Legacy candidate roots under `home` - same set adoptLargestLegacyDb scans.
 *
 * `appData`, when supplied, adds the Windows-only `%APPDATA%`-rooted roots
 * from LEGACY_ADAPTER_APPDATA_SEGMENTS (kilo, opencode - see its doc
 * comment in src/session/data-root.ts). Optional and explicit, not read
 * from `process.env` here, so this function stays pure/testable per the
 * file header's SAFETY note; only main() below resolves the real value.
 */
export function candidateLegacyRoots(home: string, appData?: string): CandidateRoot[] {
  const roots: CandidateRoot[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(home);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.startsWith(".")) continue; // profile dirs are dotfiles (.claude, .claude-ime, .codex, ...)
    roots.push({ name: entry, base: join(home, entry, "context-mode") });
  }
  for (const [name, segments] of LEGACY_ADAPTER_HOME_SEGMENTS) {
    if (segments.length < 2) continue; // one-level entries already covered by the dotfile scan above
    roots.push({ name, base: join(home, ...segments, "context-mode") });
  }
  if (appData) {
    for (const [name, segments] of LEGACY_ADAPTER_APPDATA_SEGMENTS) {
      roots.push({ name, base: join(appData, ...segments, "context-mode") });
    }
  }
  return roots;
}

function listDbFiles(base: string, subdir: Subdir): string[] {
  const dir = join(base, subdir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".db")).map((n) => join(dir, n));
}

export interface SourceFile {
  root: string;
  path: string;
}

export interface Group {
  subdir: Subdir;
  hash: string;
  /** Every discovered copy of this hash, including the global one if present. */
  sources: SourceFile[];
  globalPath: string;
}

/** Discover every `<hash>.db` under sessions/ and content/ across all legacy roots + the global root, grouped by (subdir, hash). */
export function discoverGroups(home: string, globalBase: string, appData?: string): Group[] {
  const roots: CandidateRoot[] = [...candidateLegacyRoots(home, appData), { name: "global", base: globalBase }];
  const bySubdirHash = new Map<string, Group>();
  for (const subdir of ["sessions", "content"] as const) {
    for (const root of roots) {
      for (const filePath of listDbFiles(root.base, subdir)) {
        const hash = basename(filePath, ".db");
        const key = `${subdir}:${hash}`;
        const globalPath = join(globalBase, subdir, `${hash}.db`);
        let group = bySubdirHash.get(key);
        if (!group) {
          group = { subdir, hash, sources: [], globalPath };
          bySubdirHash.set(key, group);
        }
        group.sources.push({ root: root.name, path: filePath });
      }
    }
  }
  return [...bySubdirHash.values()];
}

// ─────────────────────────────────────────────────────────
// Low-level DB helpers
// ─────────────────────────────────────────────────────────

function openReadonly(path: string): any {
  const Database = loadDatabase();
  return new Database(path, { readonly: true, timeout: 5000 });
}

function readAll(db: any, table: string): Row[] {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  } catch {
    return []; // table doesn't exist on this legacy schema - nothing to contribute
  }
}

function countTable(path: string, table: string): number {
  const db = openReadonly(path);
  try {
    return readAll(db, table).length;
  } finally {
    closeDB(db);
  }
}

function readManifest(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const db = openReadonly(path);
  try {
    const row = db.prepare("SELECT folded_sources FROM _merge_manifest WHERE id = 1").get() as
      | { folded_sources: string }
      | undefined;
    if (!row) return new Set();
    return new Set(JSON.parse(row.folded_sources) as string[]);
  } catch {
    return new Set(); // pre-migration file with no _merge_manifest table yet
  } finally {
    closeDB(db);
  }
}

function writeManifest(db: any, folded: Set<string>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _merge_manifest (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      folded_sources TEXT NOT NULL,
      merged_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.prepare(
    `INSERT INTO _merge_manifest (id, folded_sources) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET folded_sources = excluded.folded_sources, merged_at = datetime('now')`,
  ).run(JSON.stringify([...folded].sort()));
}

/** Atomically swap a freshly-built temp DB into place. Same-directory rename is atomic on POSIX and NTFS. */
function swapIntoPlace(tmpPath: string, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  renameSync(tmpPath, destPath);
  for (const suffix of ["-wal", "-shm"]) {
    try { unlinkSync(tmpPath + suffix); } catch { /* checkpointed away on close, or never existed */ }
    try { unlinkSync(destPath + suffix); } catch { /* stale sidecar from a previous file at this path */ }
  }
}

// ─────────────────────────────────────────────────────────
// Sessions DB merge
// ─────────────────────────────────────────────────────────

/** SHA256-based dedup hash - mirrors SessionDB.insertEvent (src/session/db.ts:1185-1189) exactly. */
function computeDataHash(data: string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, 16).toUpperCase();
}

/**
 * NULL/empty data_hash rule (stated per dispatch requirement): a legacy row
 * with a missing/blank data_hash is NOT dropped and NOT treated as
 * automatically unique - its effective hash is computed the same way a
 * fresh insertEvent() call would (sha256(data), first 16 hex chars,
 * uppercased). This makes such a row dedupe correctly against any other
 * copy (from another source DB) that recorded the identical event with a
 * properly-populated hash, and against other missing-hash copies of the
 * same content. It also can't accidentally collide with an unrelated event
 * that merely happens to also have a blank hash, since the effective hash
 * is content-derived, not the blank placeholder itself.
 */
function effectiveDataHash(row: Row): string {
  const raw = row.data_hash;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return computeDataHash(String(row.data ?? ""));
}

export interface TableCounts {
  session_events: number;
  session_meta: number;
  session_resume: number;
  tool_calls: number;
}

export interface SessionsGroupReport {
  subdir: "sessions";
  hash: string;
  destPath: string;
  sourcesFound: Array<{ path: string; counts: TableCounts }>;
  alreadyMerged: boolean;
  projected: TableCounts;
  applied: boolean;
}

function emptyCounts(): TableCounts {
  return { session_events: 0, session_meta: 0, session_resume: 0, tool_calls: 0 };
}

/**
 * Merge every source of a `sessions/<hash>.db` group into the global copy.
 * Dry-run (apply=false) computes and reports projected counts without
 * writing anything. Idempotent - see the IDEMPOTENCY DESIGN header comment.
 */
export function mergeSessionsGroup(group: Group, apply: boolean): SessionsGroupReport {
  const destPath = resolvePath(group.globalPath);
  const legacySources = [...new Set(
    group.sources.map((s) => resolvePath(s.path)).filter((p) => p !== destPath),
  )];

  const sourcesFound = group.sources.map((s) => ({
    path: s.path,
    counts: {
      session_events: countTable(s.path, "session_events"),
      session_meta: countTable(s.path, "session_meta"),
      session_resume: countTable(s.path, "session_resume"),
      tool_calls: countTable(s.path, "tool_calls"),
    },
  }));

  const destExists = existsSync(destPath);
  const folded = readManifest(destPath);
  const newLegacy = legacySources.filter((p) => !folded.has(p));

  if (newLegacy.length === 0) {
    const projected = destExists
      ? {
          session_events: countTable(destPath, "session_events"),
          session_meta: countTable(destPath, "session_meta"),
          session_resume: countTable(destPath, "session_resume"),
          tool_calls: countTable(destPath, "tool_calls"),
        }
      : emptyCounts();
    return { subdir: "sessions", hash: group.hash, destPath, sourcesFound, alreadyMerged: true, projected, applied: false };
  }

  const candidatePaths = destExists ? [destPath, ...newLegacy] : [...newLegacy];

  // ── Read every candidate ──
  const eventsBySession = new Map<string, Row[]>(); // session_id -> deduped rows, insertion order preserved
  const dedupeSeen = new Set<string>();
  const metaCandidates: Row[] = [];
  const resumeCandidates: Row[] = [];
  const toolCallTotals = new Map<string, { session_id: string; tool: string; calls: number; bytes_returned: number; updated_at: string }>();

  for (const path of candidatePaths) {
    const db = openReadonly(path);
    try {
      for (const row of readAll(db, "session_events")) {
        const key = `${row.session_id} ${row.type} ${effectiveDataHash(row)}`;
        if (dedupeSeen.has(key)) continue;
        dedupeSeen.add(key);
        const list = eventsBySession.get(row.session_id) ?? [];
        list.push(row);
        eventsBySession.set(row.session_id, list);
      }
      metaCandidates.push(...readAll(db, "session_meta"));
      resumeCandidates.push(...readAll(db, "session_resume"));
      for (const row of readAll(db, "tool_calls")) {
        const key = `${row.session_id} ${row.tool}`;
        const existing = toolCallTotals.get(key);
        if (existing) {
          existing.calls += Number(row.calls ?? 0);
          existing.bytes_returned += Number(row.bytes_returned ?? 0);
          if (String(row.updated_at ?? "") > existing.updated_at) existing.updated_at = row.updated_at;
        } else {
          toolCallTotals.set(key, {
            session_id: row.session_id,
            tool: row.tool,
            calls: Number(row.calls ?? 0),
            bytes_returned: Number(row.bytes_returned ?? 0),
            updated_at: row.updated_at ?? "",
          });
        }
      }
    } finally {
      closeDB(db);
    }
  }

  // ── session_meta: RECOMPUTE aggregates from the merged events, never copy ──
  const allSessionIds = new Set<string>([...eventsBySession.keys(), ...metaCandidates.map((m) => m.session_id)]);
  const mergedMeta = new Map<string, Row>();
  for (const sessionId of allSessionIds) {
    const events = eventsBySession.get(sessionId) ?? [];
    const metaRows = metaCandidates.filter((m) => m.session_id === sessionId);
    const projectDir = metaRows.find((m) => m.project_dir)?.project_dir ?? events[0]?.project_dir ?? "";
    const startedCandidates = [
      ...metaRows.map((m) => m.started_at).filter(Boolean),
      ...events.map((e) => e.created_at).filter(Boolean),
    ].sort();
    const startedAt = startedCandidates[0] ?? new Date().toISOString();
    const createdTimes = events.map((e) => e.created_at).filter(Boolean).sort();
    const lastEventAt = createdTimes.length > 0 ? createdTimes[createdTimes.length - 1] : null;
    const eventCount = events.length;
    // compact_count is recomputed as the count of merged 'compaction_summary'
    // events for this session - mirrors hooks/precompact.mjs, which emits
    // exactly one such event per incrementCompactCount() call, so counting
    // the (already deduped) events reproduces the counter without copying it.
    const compactCount = events.filter((e) => e.type === "compaction_summary").length;
    const usageCursorSource = metaRows
      .filter((m) => m.usage_cursor)
      .sort((a, b) => String(a.last_event_at ?? "").localeCompare(String(b.last_event_at ?? "")))
      .pop();
    mergedMeta.set(sessionId, {
      session_id: sessionId,
      project_dir: projectDir,
      started_at: startedAt,
      last_event_at: lastEventAt,
      event_count: eventCount,
      compact_count: compactCount,
      usage_cursor: usageCursorSource?.usage_cursor ?? null,
    });
  }

  // ── session_resume: UNIQUE on session_id, keep the row with the latest created_at ──
  const mergedResume = new Map<string, Row>();
  for (const row of resumeCandidates) {
    const existing = mergedResume.get(row.session_id);
    if (!existing || String(row.created_at ?? "") > String(existing.created_at ?? "")) {
      mergedResume.set(row.session_id, row);
    }
  }

  const projected: TableCounts = {
    session_events: [...eventsBySession.values()].reduce((n, l) => n + l.length, 0),
    session_meta: mergedMeta.size,
    session_resume: mergedResume.size,
    tool_calls: toolCallTotals.size,
  };

  if (!apply) {
    return { subdir: "sessions", hash: group.hash, destPath, sourcesFound, alreadyMerged: false, projected, applied: false };
  }

  // ── Write the merged result to a fresh temp DB, then swap it into place ──
  const tmpPath = `${destPath}.merge-tmp-${process.pid}-${Date.now()}`;
  const schemaDb = new SessionDB({ dbPath: tmpPath }); // reuse the real schema - never hand-roll DDL
  schemaDb.close();

  const Database = loadDatabase();
  const db = new Database(tmpPath, { timeout: 30000 });
  applyWALPragmas(db);
  const insertEvent = db.prepare(`
    INSERT INTO session_events (
      session_id, type, category, priority, data, project_dir,
      attribution_source, attribution_confidence, bytes_avoided, bytes_returned,
      source_hook, created_at, data_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMeta = db.prepare(`
    INSERT INTO session_meta (session_id, project_dir, started_at, last_event_at, event_count, compact_count, usage_cursor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertResume = db.prepare(`
    INSERT INTO session_resume (session_id, snapshot, event_count, created_at, consumed)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertToolCall = db.prepare(`
    INSERT INTO tool_calls (session_id, tool, calls, bytes_returned, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const events of eventsBySession.values()) {
      for (const e of events) {
        insertEvent.run(
          e.session_id, e.type, e.category, e.priority ?? 2, e.data,
          e.project_dir ?? "", e.attribution_source ?? "unknown", e.attribution_confidence ?? 0,
          e.bytes_avoided ?? 0, e.bytes_returned ?? 0, e.source_hook ?? "unknown",
          e.created_at ?? new Date().toISOString(), effectiveDataHash(e),
        );
      }
    }
    for (const m of mergedMeta.values()) {
      insertMeta.run(m.session_id, m.project_dir, m.started_at, m.last_event_at, m.event_count, m.compact_count, m.usage_cursor);
    }
    for (const r of mergedResume.values()) {
      insertResume.run(r.session_id, r.snapshot, r.event_count, r.created_at ?? new Date().toISOString(), r.consumed ?? 0);
    }
    for (const t of toolCallTotals.values()) {
      insertToolCall.run(t.session_id, t.tool, t.calls, t.bytes_returned, t.updated_at || new Date().toISOString());
    }
    writeManifest(db, new Set([...folded, ...legacySources]));
  });
  tx.immediate();
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
  closeDB(db);

  swapIntoPlace(tmpPath, destPath);

  return { subdir: "sessions", hash: group.hash, destPath, sourcesFound, alreadyMerged: false, projected, applied: true };
}

// ─────────────────────────────────────────────────────────
// Content DB merge
// ─────────────────────────────────────────────────────────

export interface ContentTableCounts {
  sources: number;
  chunks: number;
  vocabulary: number;
}

export interface ContentGroupReport {
  subdir: "content";
  hash: string;
  destPath: string;
  sourcesFound: Array<{ path: string; counts: ContentTableCounts }>;
  alreadyMerged: boolean;
  projected: ContentTableCounts;
  applied: boolean;
}

interface SourceCandidate {
  origin: string; // resolved path of the DB this row came from
  oldId: number;
  row: Row;
}

/**
 * Pick the winning `sources` row for a group of candidates that share the
 * same label. Dedupe key is (label, content_hash):
 *  - Rows with an identical, non-null content_hash are true duplicates
 *    (same file content indexed from more than one profile) - collapse to
 *    one, any representative works since the content is provably identical.
 *  - Rows with DIFFERENT content_hash values under the same label, or with
 *    a NULL content_hash (label-only sources - plain-text/JSON content that
 *    was never file-backed, so no hash was ever computed), are treated as
 *    successive versions of the same logical source. Only the most
 *    recently-indexed version survives; this mirrors the app's own
 *    single-active-source-per-label invariant (ContentStore#insertChunks
 *    deletes any existing row for a label before inserting the new one -
 *    a re-index always supersedes, it never keeps both). Older versions are
 *    intentionally dropped, same as a live re-index would drop them.
 */
function pickWinner(candidates: SourceCandidate[]): SourceCandidate {
  // Non-null content_hash: true duplicates (identical hash) collapse to one
  // representative. Null content_hash (label-only): two label-only rows are
  // NEVER assumed identical just because both lack a hash, so each is kept
  // as its own distinct version below (never collapsed with another).
  const distinctVersions: SourceCandidate[] = [];
  const seenHash = new Map<string, SourceCandidate>();
  for (const c of candidates) {
    const hash = c.row.content_hash;
    if (hash == null) {
      distinctVersions.push(c);
    } else if (!seenHash.has(hash)) {
      seenHash.set(hash, c);
      distinctVersions.push(c);
    }
  }
  if (distinctVersions.length === 1) return distinctVersions[0];
  distinctVersions.sort((a, b) => String(a.row.indexed_at ?? "").localeCompare(String(b.row.indexed_at ?? "")));
  return distinctVersions[distinctVersions.length - 1];
}

export function mergeContentGroup(group: Group, apply: boolean): ContentGroupReport {
  const destPath = resolvePath(group.globalPath);
  const legacySources = [...new Set(
    group.sources.map((s) => resolvePath(s.path)).filter((p) => p !== destPath),
  )];

  const sourcesFound = group.sources.map((s) => ({
    path: s.path,
    counts: {
      sources: countTable(s.path, "sources"),
      chunks: countTable(s.path, "chunks"),
      vocabulary: countTable(s.path, "vocabulary"),
    },
  }));

  const destExists = existsSync(destPath);
  const folded = readManifest(destPath);
  const newLegacy = legacySources.filter((p) => !folded.has(p));

  if (newLegacy.length === 0) {
    const projected = destExists
      ? {
          sources: countTable(destPath, "sources"),
          chunks: countTable(destPath, "chunks"),
          vocabulary: countTable(destPath, "vocabulary"),
        }
      : { sources: 0, chunks: 0, vocabulary: 0 };
    return { subdir: "content", hash: group.hash, destPath, sourcesFound, alreadyMerged: true, projected, applied: false };
  }

  const candidatePaths = destExists ? [destPath, ...newLegacy] : [...newLegacy];

  const byLabel = new Map<string, SourceCandidate[]>();
  const vocabWords = new Set<string>();
  // chunks read lazily per-winner below, keyed by (origin path, oldId).
  for (const origin of candidatePaths) {
    const db = openReadonly(origin);
    try {
      for (const row of readAll(db, "sources")) {
        const list = byLabel.get(row.label) ?? [];
        list.push({ origin, oldId: row.id, row });
        byLabel.set(row.label, list);
      }
      for (const row of readAll(db, "vocabulary")) {
        vocabWords.add(row.word);
      }
    } finally {
      closeDB(db);
    }
  }

  const winners = [...byLabel.values()].map(pickWinner);

  const projected: ContentTableCounts = {
    sources: winners.length,
    chunks: 0, // filled in below once chunk rows are actually read
    vocabulary: vocabWords.size,
  };

  // Read the winning chunks now (needed for both dry-run counts and apply).
  const chunksByWinner = new Map<SourceCandidate, Row[]>();
  const openDbs = new Map<string, any>();
  try {
    for (const winner of winners) {
      let db = openDbs.get(winner.origin);
      if (!db) {
        db = openReadonly(winner.origin);
        openDbs.set(winner.origin, db);
      }
      let rows: Row[];
      try {
        rows = db.prepare(`SELECT rowid, title, content, source_id, content_type, source_category, session_id, event_id, timestamp FROM chunks WHERE source_id = ?`).all(winner.oldId) as Row[];
      } catch {
        rows = [];
      }
      chunksByWinner.set(winner, rows);
      projected.chunks += rows.length;
    }
  } finally {
    for (const db of openDbs.values()) closeDB(db);
  }

  if (!apply) {
    return { subdir: "content", hash: group.hash, destPath, sourcesFound, alreadyMerged: false, projected, applied: false };
  }

  const tmpPath = `${destPath}.merge-tmp-${process.pid}-${Date.now()}`;
  const schemaStore = new ContentStore(tmpPath); // reuse the real schema - never hand-roll FTS5 DDL
  schemaStore.close();

  const Database = loadDatabase();
  const db = new Database(tmpPath, { timeout: 30000 });
  applyWALPragmas(db);
  // Same column list/order as ContentStore's own #stmtInsertSource /
  // #stmtInsertChunk / #stmtInsertChunkTrigram (src/store.ts) - this IS the
  // normal FTS5 write path (a plain INSERT INTO the virtual table, which is
  // the only supported way to populate it; the internal *_data/*_idx shadow
  // tables are never touched directly). indexed_at is set explicitly here
  // (store.ts relies on the column default instead) so the merge preserves
  // real history instead of stamping every migrated source with "now".
  const insertSource = db.prepare(`
    INSERT INTO sources (label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertChunk = db.prepare(`
    INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertChunkTrigram = db.prepare(`
    INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertVocab = db.prepare(`INSERT OR IGNORE INTO vocabulary (word) VALUES (?)`);

  const tx = db.transaction(() => {
    for (const winner of winners) {
      const chunks = chunksByWinner.get(winner) ?? [];
      const codeChunks = chunks.filter((c) => c.content_type === "code").length;
      const info = insertSource.run(
        winner.row.label, chunks.length, codeChunks,
        winner.row.indexed_at ?? new Date().toISOString(),
        winner.row.file_path ?? null, winner.row.content_hash ?? null,
      );
      const newSourceId = Number(info.lastInsertRowid);
      for (const c of chunks) {
        insertChunk.run(c.title, c.content, newSourceId, c.content_type, c.source_category ?? null, c.session_id ?? "", c.event_id ?? "", c.timestamp ?? null);
        insertChunkTrigram.run(c.title, c.content, newSourceId, c.content_type, c.source_category ?? null, c.session_id ?? "", c.event_id ?? "", c.timestamp ?? null);
      }
    }
    for (const word of vocabWords) insertVocab.run(word);
    writeManifest(db, new Set([...folded, ...legacySources]));
  });
  tx.immediate();
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
  closeDB(db);

  swapIntoPlace(tmpPath, destPath);

  return { subdir: "content", hash: group.hash, destPath, sourcesFound, alreadyMerged: false, projected, applied: true };
}

// ─────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────

export type AnyGroupReport = SessionsGroupReport | ContentGroupReport;

/**
 * Run (or dry-run) the full migration: discover every group, merge each one
 * that actually has a legacy (non-global) source. Groups that live only in
 * the global store already, or have already been fully folded in, are
 * skipped without opening a writable handle to anything.
 */
export function runMigration(home: string, globalBase: string, opts: { apply: boolean }, appData?: string): AnyGroupReport[] {
  const groups = discoverGroups(home, globalBase, appData);
  const reports: AnyGroupReport[] = [];
  for (const group of groups) {
    const hasLegacy = group.sources.some((s) => resolvePath(s.path) !== resolvePath(group.globalPath));
    if (!hasLegacy) continue; // global-only key - nothing to merge (443-keys case in the plan)
    reports.push(
      group.subdir === "sessions"
        ? mergeSessionsGroup(group, opts.apply)
        : mergeContentGroup(group, opts.apply),
    );
  }
  return reports;
}

export function formatReport(reports: AnyGroupReport[], apply: boolean): string {
  const lines: string[] = [];
  lines.push(`merge-stores ${apply ? "APPLY" : "DRY RUN"} - ${reports.length} group(s) with legacy data found`);
  for (const r of reports) {
    lines.push(`\n[${r.subdir}] ${r.hash}${r.alreadyMerged ? " (already merged - no-op)" : ""}`);
    lines.push(`  destination: ${r.destPath}`);
    for (const s of r.sourcesFound) {
      lines.push(`  source: ${s.path} -> ${JSON.stringify(s.counts)}`);
    }
    lines.push(`  projected post-merge: ${JSON.stringify(r.projected)}${r.applied ? " (written)" : ""}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────
// CLI entry point - never invoked by importing this module
// ─────────────────────────────────────────────────────────

function main(): void {
  const apply = process.argv.includes("--apply");
  const home = homedir();
  const globalBase = join(resolveContextModeDataRoot(process.env, home), "context-mode");
  // Same fallback as OpenCodeAdapter.getConfigDir (src/adapters/opencode/index.ts)
  // so a Windows account without APPDATA set (service accounts, some CI
  // images) still finds a store that adapter would have written there.
  const appData = process.platform === "win32" ? process.env.APPDATA || join(home, "AppData", "Roaming") : undefined;
  const reports = runMigration(home, globalBase, { apply }, appData);
  console.log(formatReport(reports, apply));
  if (!apply) {
    console.log("\nDry run only - pass --apply to perform the merge.");
  }
}

const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) {
  main();
}
