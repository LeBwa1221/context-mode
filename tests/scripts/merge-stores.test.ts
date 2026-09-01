/**
 * merge-stores - tests for the phase-2 store-unification migration script
 * (scripts/merge-stores.ts, docs/plan-store-unification.md).
 *
 * Every fixture lives under a throwaway mkdtempSync() directory that is
 * NEVER anywhere near a real context-mode store. discoverGroups/
 * mergeSessionsGroup/mergeContentGroup/runMigration all take `home` and
 * `globalBase` as explicit parameters (see scripts/merge-stores.ts's header
 * comment) - nothing here ever calls homedir() or
 * resolveContextModeDataRoot() for real, so there is no path by which these
 * tests could touch %LOCALAPPDATA%\context-mode, ~/.claude*, or any other
 * real store. "../setup-home" is still imported for defense in depth (it
 * mocks node:os.homedir() to a fake temp dir for this file), matching the
 * convention every other store test in this repo already uses.
 */
import "../setup-home";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadDatabase, applyWALPragmas, closeDB } from "../../src/db-base.js";
import { SessionDB } from "../../src/session/db.js";
import { ContentStore } from "../../src/store.js";
import {
  discoverGroups,
  mergeSessionsGroup,
  mergeContentGroup,
  runMigration,
  candidateLegacyRoots,
  type Group,
} from "../../scripts/merge-stores.js";

const cleanup: string[] = [];
afterEach(() => {
  while (cleanup.length) {
    const p = cleanup.pop();
    if (p && existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(d);
  return d;
}

function sessionsPath(root: string, hash: string): string {
  return join(root, "sessions", `${hash}.db`);
}
function contentPath(root: string, hash: string): string {
  return join(root, "content", `${hash}.db`);
}

/** Create a sessions DB at `path` with the real schema (via SessionDB), then close it. */
function makeSessionsSchema(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new SessionDB({ dbPath: path });
  db.close();
}

/** Create a content DB at `path` with the real schema (via ContentStore), then close it. */
function makeContentSchema(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const store = new ContentStore(path);
  store.close();
}

function rawOpen(path: string): any {
  const Database = loadDatabase();
  const db = new Database(path, { timeout: 5000 });
  applyWALPragmas(db);
  return db;
}

function insertEvent(db: any, e: {
  session_id: string; type: string; category?: string; priority?: number; data: string;
  project_dir?: string; created_at?: string; data_hash?: string;
}): void {
  db.prepare(`
    INSERT INTO session_events (session_id, type, category, priority, data, project_dir, attribution_source, attribution_confidence, bytes_avoided, bytes_returned, source_hook, created_at, data_hash)
    VALUES (?, ?, ?, ?, ?, ?, 'unknown', 0, 0, 0, 'test', ?, ?)
  `).run(
    e.session_id, e.type, e.category ?? "info", e.priority ?? 2, e.data,
    e.project_dir ?? "/proj", e.created_at ?? "2026-01-01 00:00:00", e.data_hash ?? "",
  );
}

function insertMeta(db: any, m: {
  session_id: string; project_dir?: string; started_at?: string; last_event_at?: string | null;
  event_count?: number; compact_count?: number;
}): void {
  db.prepare(`
    INSERT INTO session_meta (session_id, project_dir, started_at, last_event_at, event_count, compact_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(m.session_id, m.project_dir ?? "/proj", m.started_at ?? "2026-01-01 00:00:00", m.last_event_at ?? null, m.event_count ?? 0, m.compact_count ?? 0);
}

function insertToolCall(db: any, t: { session_id: string; tool: string; calls: number; bytes_returned: number; updated_at?: string }): void {
  db.prepare(`
    INSERT INTO tool_calls (session_id, tool, calls, bytes_returned, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(t.session_id, t.tool, t.calls, t.bytes_returned, t.updated_at ?? "2026-01-01 00:00:00");
}

function insertResume(db: any, r: { session_id: string; snapshot: string; event_count: number; created_at: string; consumed?: number }): void {
  db.prepare(`
    INSERT INTO session_resume (session_id, snapshot, event_count, created_at, consumed)
    VALUES (?, ?, ?, ?, ?)
  `).run(r.session_id, r.snapshot, r.event_count, r.created_at, r.consumed ?? 0);
}

function insertSource(db: any, s: { label: string; chunk_count: number; code_chunk_count: number; indexed_at: string; file_path?: string | null; content_hash?: string | null }): number {
  const info = db.prepare(`
    INSERT INTO sources (label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(s.label, s.chunk_count, s.code_chunk_count, s.indexed_at, s.file_path ?? null, s.content_hash ?? null);
  return Number(info.lastInsertRowid);
}

function insertChunk(db: any, c: { title: string; content: string; source_id: number; content_type: string }): void {
  for (const table of ["chunks", "chunks_trigram"]) {
    db.prepare(`
      INSERT INTO ${table} (title, content, source_id, content_type, source_category, session_id, event_id, timestamp)
      VALUES (?, ?, ?, ?, NULL, '', '', ?)
    `).run(c.title, c.content, c.source_id, c.content_type, "2026-01-01T00:00:00.000Z");
  }
}

function group(subdir: "sessions" | "content", hash: string, sourcePaths: Array<{ root: string; path: string }>, globalPath: string): Group {
  return { subdir, hash, sources: sourcePaths, globalPath };
}

// ─────────────────────────────────────────────────────────
// Enumeration
// ─────────────────────────────────────────────────────────

describe("candidateLegacyRoots / discoverGroups", () => {
  it("finds one-level dotfile profiles and groups by (subdir, hash), including the global copy", () => {
    const home = tempDir("merge-home-");
    const globalBase = join(tempDir("merge-global-"), "context-mode");
    const hash = "abc123";

    const imeRoot = join(home, ".claude-ime", "context-mode");
    makeSessionsSchema(sessionsPath(imeRoot, hash));
    makeSessionsSchema(sessionsPath(globalBase, hash));

    const roots = candidateLegacyRoots(home);
    expect(roots.some((r) => r.name === ".claude-ime")).toBe(true);

    // Windows-only supplement: passing `appData` adds the %APPDATA%-rooted
    // roots from LEGACY_ADAPTER_APPDATA_SEGMENTS (kilo, opencode) - must
    // pass on every platform since `appData` here is just a string, never
    // read from process.env.
    const appDataRoots = candidateLegacyRoots(home, "/fake/appdata");
    expect(appDataRoots.some((r) => r.base === join("/fake/appdata", "opencode", "context-mode"))).toBe(true);
    expect(appDataRoots.some((r) => r.base === join("/fake/appdata", "kilo", "context-mode"))).toBe(true);

    const groups = discoverGroups(home, globalBase);
    const g = groups.find((x) => x.subdir === "sessions" && x.hash === hash);
    expect(g).toBeDefined();
    expect(g!.sources.length).toBe(2);
    expect(g!.sources.some((s) => s.root === ".claude-ime")).toBe(true);
    expect(g!.sources.some((s) => s.root === "global")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// Sessions merge
// ─────────────────────────────────────────────────────────

describe("mergeSessionsGroup", () => {
  it("merges two divergent legacy sources + a global copy into a superset, per table (no copy is a superset alone)", () => {
    const hash = "sess1";
    const globalRoot = join(tempDir("g-"), "context-mode");
    const imeRoot = join(tempDir("ime-"), "context-mode");
    const devcomRoot = join(tempDir("devcom-"), "context-mode");

    const globalPath = sessionsPath(globalRoot, hash);
    const imePath = sessionsPath(imeRoot, hash);
    const devcomPath = sessionsPath(devcomRoot, hash);
    makeSessionsSchema(globalPath);
    makeSessionsSchema(imePath);
    makeSessionsSchema(devcomPath);

    // global: has event A + a tool_calls row, but not B or C
    let db = rawOpen(globalPath);
    insertEvent(db, { session_id: "s1", type: "tool_call", data: "A", created_at: "2026-01-01 00:00:00" });
    insertToolCall(db, { session_id: "s1", tool: "Read", calls: 2, bytes_returned: 100 });
    closeDB(db);

    // ime: has event B (unique) + event A duplicated verbatim (must dedupe)
    db = rawOpen(imePath);
    insertEvent(db, { session_id: "s1", type: "tool_call", data: "A", created_at: "2026-01-01 00:00:00" });
    insertEvent(db, { session_id: "s1", type: "tool_call", data: "B", created_at: "2026-01-01 00:01:00" });
    closeDB(db);

    // devcom: has event C (unique), nothing else overlaps
    db = rawOpen(devcomPath);
    insertEvent(db, { session_id: "s1", type: "tool_call", data: "C", created_at: "2026-01-01 00:02:00" });
    closeDB(db);

    const g = group("sessions", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
      { root: ".claude-devcom", path: devcomPath },
    ], globalPath);

    const report = mergeSessionsGroup(g, true);
    expect(report.applied).toBe(true);
    // Superset: A, B, C all present exactly once (dedup collapsed the duplicate A) = 3 events.
    expect(report.projected.session_events).toBe(3);

    const merged = rawOpen(globalPath);
    const rows = merged.prepare("SELECT type, data FROM session_events ORDER BY data").all() as Array<{ data: string }>;
    closeDB(merged);
    expect(rows.map((r) => r.data)).toEqual(["A", "B", "C"]);
  });

  it("sums tool_calls counters across sources instead of overwriting (the silent-undercount case)", () => {
    const hash = "sess2";
    const globalPath = sessionsPath(join(tempDir("g2-"), "context-mode"), hash);
    const imePath = sessionsPath(join(tempDir("ime2-"), "context-mode"), hash);
    makeSessionsSchema(globalPath);
    makeSessionsSchema(imePath);

    let db = rawOpen(globalPath);
    insertToolCall(db, { session_id: "s1", tool: "Read", calls: 5, bytes_returned: 500, updated_at: "2026-01-01 00:00:00" });
    closeDB(db);

    db = rawOpen(imePath);
    insertToolCall(db, { session_id: "s1", tool: "Read", calls: 3, bytes_returned: 200, updated_at: "2026-01-02 00:00:00" });
    closeDB(db);

    const g = group("sessions", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    mergeSessionsGroup(g, true);

    const merged = rawOpen(globalPath);
    const row = merged.prepare("SELECT calls, bytes_returned FROM tool_calls WHERE session_id = 's1' AND tool = 'Read'").get() as { calls: number; bytes_returned: number };
    closeDB(merged);
    // A naive overwrite would leave 5 or 3; the correct merge sums to 8.
    expect(row.calls).toBe(8);
    expect(row.bytes_returned).toBe(700);
  });

  it("recomputes session_meta aggregates from the merged events instead of copying stale counters", () => {
    const hash = "sess3";
    const globalPath = sessionsPath(join(tempDir("g3-"), "context-mode"), hash);
    const imePath = sessionsPath(join(tempDir("ime3-"), "context-mode"), hash);
    makeSessionsSchema(globalPath);
    makeSessionsSchema(imePath);

    // global's own session_meta claims event_count=1 (correct for its OWN one event),
    // but after merging in ime's 2 additional events the true count is 3 - copying
    // either side's stale event_count would give the wrong answer (1 or a naive
    // max() of 2), only recomputing from the merged set gives 3.
    let db = rawOpen(globalPath);
    insertEvent(db, { session_id: "s1", type: "t", data: "A", created_at: "2026-01-01 00:00:00" });
    insertMeta(db, { session_id: "s1", event_count: 1, compact_count: 0, last_event_at: "2026-01-01 00:00:00" });
    closeDB(db);

    db = rawOpen(imePath);
    insertEvent(db, { session_id: "s1", type: "t", data: "B", created_at: "2026-01-01 00:01:00" });
    insertEvent(db, { session_id: "s1", type: "compaction_summary", category: "compaction", data: "compacted", created_at: "2026-01-01 00:02:00" });
    insertMeta(db, { session_id: "s1", event_count: 2, compact_count: 1, last_event_at: "2026-01-01 00:02:00" });
    closeDB(db);

    const g = group("sessions", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    mergeSessionsGroup(g, true);

    const merged = rawOpen(globalPath);
    const meta = merged.prepare("SELECT event_count, compact_count, last_event_at FROM session_meta WHERE session_id = 's1'").get() as
      { event_count: number; compact_count: number; last_event_at: string };
    closeDB(merged);
    expect(meta.event_count).toBe(3); // A + B + compaction_summary, recomputed
    expect(meta.compact_count).toBe(1); // one compaction_summary event, recomputed - not copied from either side
    expect(meta.last_event_at).toBe("2026-01-01 00:02:00");
  });

  it("handles NULL/absent data_hash per the stated rule: computed the same way insertEvent does, so it still dedupes correctly", () => {
    const hash = "sess4";
    const globalPath = sessionsPath(join(tempDir("g4-"), "context-mode"), hash);
    const imePath = sessionsPath(join(tempDir("ime4-"), "context-mode"), hash);
    makeSessionsSchema(globalPath);
    makeSessionsSchema(imePath);

    // Both sides recorded the SAME event content but neither ever populated data_hash
    // (legacy row, pre-v1.0.130 style). Rule: compute sha256(data) the same way
    // insertEvent() would, so these still collapse to ONE merged row, not two.
    let db = rawOpen(globalPath);
    insertEvent(db, { session_id: "s1", type: "t", data: "same-content", data_hash: "" });
    closeDB(db);
    db = rawOpen(imePath);
    insertEvent(db, { session_id: "s1", type: "t", data: "same-content", data_hash: "" });
    // Plus one more legacy row with NULL-ish data_hash and DIFFERENT content -
    // must survive as its own row, not get merged away just because its hash was blank.
    insertEvent(db, { session_id: "s1", type: "t", data: "different-content", data_hash: "" });
    closeDB(db);

    const g = group("sessions", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    const report = mergeSessionsGroup(g, true);
    expect(report.projected.session_events).toBe(2); // deduped same-content, kept different-content

    const merged = rawOpen(globalPath);
    const rows = merged.prepare("SELECT data, data_hash FROM session_events ORDER BY data").all() as Array<{ data: string; data_hash: string }>;
    closeDB(merged);
    expect(rows.map((r) => r.data)).toEqual(["different-content", "same-content"]);
    // The stored data_hash was backfilled (non-empty) even though the source rows had none.
    expect(rows.every((r) => r.data_hash.length > 0)).toBe(true);
  });

  it("is idempotent: running the merge twice does not double-count", () => {
    const hash = "sess5";
    const globalPath = sessionsPath(join(tempDir("g5-"), "context-mode"), hash);
    const imePath = sessionsPath(join(tempDir("ime5-"), "context-mode"), hash);
    makeSessionsSchema(globalPath);
    makeSessionsSchema(imePath);

    let db = rawOpen(globalPath);
    insertEvent(db, { session_id: "s1", type: "t", data: "A" });
    insertToolCall(db, { session_id: "s1", tool: "Read", calls: 5, bytes_returned: 500 });
    closeDB(db);

    db = rawOpen(imePath);
    insertEvent(db, { session_id: "s1", type: "t", data: "B" });
    insertToolCall(db, { session_id: "s1", tool: "Read", calls: 3, bytes_returned: 200 });
    closeDB(db);

    const g = group("sessions", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    const first = mergeSessionsGroup(g, true);
    expect(first.applied).toBe(true);
    expect(first.projected.session_events).toBe(2);

    const second = mergeSessionsGroup(g, true);
    expect(second.applied).toBe(false); // manifest already covers ime - no-op
    expect(second.alreadyMerged).toBe(true);
    expect(second.projected.session_events).toBe(2); // unchanged, not 4

    const merged = rawOpen(globalPath);
    const eventCount = (merged.prepare("SELECT COUNT(*) AS c FROM session_events").get() as { c: number }).c;
    const toolCallRow = merged.prepare("SELECT calls, bytes_returned FROM tool_calls WHERE session_id='s1' AND tool='Read'").get() as { calls: number; bytes_returned: number };
    closeDB(merged);
    expect(eventCount).toBe(2);
    expect(toolCallRow.calls).toBe(8); // still 8, not 16
    expect(toolCallRow.bytes_returned).toBe(700);
  });

  it("dry-run writes nothing: target file mtime and size are unchanged", () => {
    const hash = "sess6";
    const globalPath = sessionsPath(join(tempDir("g6-"), "context-mode"), hash);
    const imePath = sessionsPath(join(tempDir("ime6-"), "context-mode"), hash);
    makeSessionsSchema(globalPath);
    makeSessionsSchema(imePath);

    let db = rawOpen(globalPath);
    insertEvent(db, { session_id: "s1", type: "t", data: "A" });
    closeDB(db);
    db = rawOpen(imePath);
    insertEvent(db, { session_id: "s1", type: "t", data: "B" });
    closeDB(db);

    const before = statSync(globalPath);

    const g = group("sessions", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    const report = mergeSessionsGroup(g, false);
    expect(report.applied).toBe(false);
    expect(report.projected.session_events).toBe(2); // still reports the projected merge

    const after = statSync(globalPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});

// ─────────────────────────────────────────────────────────
// Content merge
// ─────────────────────────────────────────────────────────

describe("mergeContentGroup", () => {
  it("remaps colliding AUTOINCREMENT source ids so both survive with their chunks intact", () => {
    const hash = "cont1";
    const globalPath = contentPath(join(tempDir("g7-"), "context-mode"), hash);
    const imePath = contentPath(join(tempDir("ime7-"), "context-mode"), hash);
    makeContentSchema(globalPath);
    makeContentSchema(imePath);

    // Both DBs' first source row gets id=1 (AAUTOINCREMENT starts at 1 in each
    // independently) but the label/content differ - both must survive after merge.
    let db = rawOpen(globalPath);
    const globalSourceId = insertSource(db, { label: "file-a.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00", content_hash: "hashA" });
    insertChunk(db, { title: "A", content: "alpha content unique-alpha-token", source_id: globalSourceId, content_type: "prose" });
    closeDB(db);

    db = rawOpen(imePath);
    const imeSourceId = insertSource(db, { label: "file-b.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00", content_hash: "hashB" });
    insertChunk(db, { title: "B", content: "beta content unique-beta-token", source_id: imeSourceId, content_type: "prose" });
    closeDB(db);

    expect(globalSourceId).toBe(imeSourceId); // confirms the collision setup

    const g = group("content", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    const report = mergeContentGroup(g, true);
    expect(report.applied).toBe(true);
    expect(report.projected.sources).toBe(2);
    expect(report.projected.chunks).toBe(2);

    const merged = rawOpen(globalPath);
    const sources = merged.prepare("SELECT id, label FROM sources ORDER BY label").all() as Array<{ id: number; label: string }>;
    closeDB(merged);
    expect(sources.map((s) => s.label)).toEqual(["file-a.md", "file-b.md"]);
    expect(new Set(sources.map((s) => s.id)).size).toBe(2); // distinct ids, no collision survived

    const store = new ContentStore(globalPath);
    try {
      const aRow = store.search("unique-alpha-token")[0];
      const bRow = store.search("unique-beta-token")[0];
      expect(aRow?.source).toBe("file-a.md");
      expect(bRow?.source).toBe("file-b.md");
    } finally {
      store.close();
    }
  });

  it("dedupes label-only sources (no content_hash) by keeping only the most recently indexed version", () => {
    const hash = "cont2";
    const globalPath = contentPath(join(tempDir("g8-"), "context-mode"), hash);
    const imePath = contentPath(join(tempDir("ime8-"), "context-mode"), hash);
    makeContentSchema(globalPath);
    makeContentSchema(imePath);

    let db = rawOpen(globalPath);
    let sid = insertSource(db, { label: "build-log", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00", content_hash: null });
    insertChunk(db, { title: "old", content: "old build output", source_id: sid, content_type: "prose" });
    closeDB(db);

    db = rawOpen(imePath);
    sid = insertSource(db, { label: "build-log", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-02 00:00:00", content_hash: null });
    insertChunk(db, { title: "new", content: "new build output", source_id: sid, content_type: "prose" });
    closeDB(db);

    const g = group("content", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    mergeContentGroup(g, true);

    const merged = rawOpen(globalPath);
    const sources = merged.prepare("SELECT indexed_at FROM sources WHERE label='build-log'").all() as Array<{ indexed_at: string }>;
    const chunks = merged.prepare("SELECT content FROM chunks").all() as Array<{ content: string }>;
    closeDB(merged);
    expect(sources.length).toBe(1); // only the newer version survives
    expect(sources[0].indexed_at).toBe("2026-01-02 00:00:00");
    expect(chunks.map((c) => c.content)).toEqual(["new build output"]);
  });

  it("FTS actually works post-merge: search returns hits from BOTH source DBs, including content unique to one", () => {
    const hash = "cont3";
    const globalPath = contentPath(join(tempDir("g9-"), "context-mode"), hash);
    const imePath = contentPath(join(tempDir("ime9-"), "context-mode"), hash);
    const devcomPath = contentPath(join(tempDir("devcom9-"), "context-mode"), hash);
    makeContentSchema(globalPath);
    makeContentSchema(imePath);
    makeContentSchema(devcomPath);

    let db = rawOpen(globalPath);
    let sid = insertSource(db, { label: "doc-global.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00" });
    insertChunk(db, { title: "g", content: "globalonly zebraword content", source_id: sid, content_type: "prose" });
    closeDB(db);

    db = rawOpen(imePath);
    sid = insertSource(db, { label: "doc-ime.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00" });
    insertChunk(db, { title: "i", content: "imeonly giraffeword content", source_id: sid, content_type: "prose" });
    closeDB(db);

    db = rawOpen(devcomPath);
    sid = insertSource(db, { label: "doc-devcom.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00" });
    insertChunk(db, { title: "d", content: "devcomonly quokkaword content", source_id: sid, content_type: "prose" });
    closeDB(db);

    const g = group("content", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
      { root: ".claude-devcom", path: devcomPath },
    ], globalPath);

    mergeContentGroup(g, true);

    const store = new ContentStore(globalPath);
    try {
      expect(store.search("zebraword").length).toBeGreaterThan(0);
      expect(store.search("giraffeword").length).toBeGreaterThan(0);
      expect(store.search("quokkaword").length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("is idempotent for content merges too (sources/chunks/vocabulary counts unchanged on re-run)", () => {
    const hash = "cont4";
    const globalPath = contentPath(join(tempDir("g10-"), "context-mode"), hash);
    const imePath = contentPath(join(tempDir("ime10-"), "context-mode"), hash);
    makeContentSchema(globalPath);
    makeContentSchema(imePath);

    let db = rawOpen(globalPath);
    let sid = insertSource(db, { label: "a.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00", content_hash: "h1" });
    insertChunk(db, { title: "a", content: "alpha", source_id: sid, content_type: "prose" });
    closeDB(db);

    db = rawOpen(imePath);
    sid = insertSource(db, { label: "b.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00", content_hash: "h2" });
    insertChunk(db, { title: "b", content: "beta", source_id: sid, content_type: "prose" });
    closeDB(db);

    const g = group("content", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);

    const first = mergeContentGroup(g, true);
    expect(first.projected.sources).toBe(2);

    const second = mergeContentGroup(g, true);
    expect(second.alreadyMerged).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.projected.sources).toBe(2);
    expect(second.projected.chunks).toBe(2);
  });

  it("dry-run writes nothing to the content store either", () => {
    const hash = "cont5";
    const globalPath = contentPath(join(tempDir("g11-"), "context-mode"), hash);
    const imePath = contentPath(join(tempDir("ime11-"), "context-mode"), hash);
    makeContentSchema(globalPath);
    makeContentSchema(imePath);

    let db = rawOpen(imePath);
    const sid = insertSource(db, { label: "x.md", chunk_count: 1, code_chunk_count: 0, indexed_at: "2026-01-01 00:00:00" });
    insertChunk(db, { title: "x", content: "xylophone", source_id: sid, content_type: "prose" });
    closeDB(db);

    const before = statSync(globalPath);
    const g = group("content", hash, [
      { root: "global", path: globalPath },
      { root: ".claude-ime", path: imePath },
    ], globalPath);
    const report = mergeContentGroup(g, false);
    expect(report.applied).toBe(false);
    expect(report.projected.sources).toBe(1);

    const after = statSync(globalPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});

// ─────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────

describe("runMigration", () => {
  it("skips global-only keys and only merges groups with an actual legacy source", () => {
    const home = tempDir("run-home-");
    const globalBase = join(tempDir("run-global-"), "context-mode");

    // global-only hash - no legacy copy anywhere, should be skipped entirely (untouched).
    const globalOnlyHash = "onlyglobal";
    makeSessionsSchema(sessionsPath(globalBase, globalOnlyHash));
    const beforeStat = statSync(sessionsPath(globalBase, globalOnlyHash));

    // overlapping hash - legacy + global, should be merged.
    const overlapHash = "overlap1";
    const imeRoot = join(home, ".claude-ime", "context-mode");
    makeSessionsSchema(sessionsPath(globalBase, overlapHash));
    makeSessionsSchema(sessionsPath(imeRoot, overlapHash));
    let db = rawOpen(sessionsPath(imeRoot, overlapHash));
    insertEvent(db, { session_id: "s1", type: "t", data: "only-in-ime" });
    closeDB(db);

    const reports = runMigration(home, globalBase, { apply: true });
    expect(reports.length).toBe(1);
    expect(reports[0].hash).toBe(overlapHash);

    const afterStat = statSync(sessionsPath(globalBase, globalOnlyHash));
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs); // global-only file never touched

    const merged = rawOpen(sessionsPath(globalBase, overlapHash));
    const row = merged.prepare("SELECT data FROM session_events WHERE session_id='s1'").get() as { data: string };
    closeDB(merged);
    expect(row.data).toBe("only-in-ime");
  });
});
