/**
 * db-base — Reusable SQLite infrastructure for context-mode packages.
 *
 * Provides lazy-loading of better-sqlite3, WAL pragma setup, prepared
 * statement caching interface, and DB file cleanup helpers. Both
 * ContentStore and SessionDB build on top of these primitives.
 */

import type DatabaseConstructor from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { createRequire } from "node:module";
import { existsSync, unlinkSync, renameSync, readdirSync, statSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEGACY_ADAPTER_HOME_SEGMENTS } from "./session/data-root.js";
// v1.0.130 — `acquireDbLock` + `locking_mode = EXCLUSIVE` were REMOVED.
// See docs/adr/0001-sessiondb-multi-writer.md for the architectural
// rationale. The short version: SessionDB is multi-writer-safe and the
// process-identity invariants the lockfile tried to enforce belong in
// the process layer (sibling-mcp), not the DB layer. WAL + busy_timeout
// + withRetry handle the actual concurrency safely.

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/**
 * Explicit interface for cached prepared statements that accept varying
 * parameter counts. better-sqlite3's generic `Statement` collapses under
 * `ReturnType` to a single-param signature, so we define our own.
 */
export interface PreparedStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

// ─────────────────────────────────────────────────────────
// bun:sqlite adapter (#45)
// ─────────────────────────────────────────────────────────

/**
 * Wraps a bun:sqlite Database to provide better-sqlite3-compatible API.
 * Bridges: .pragma(), multi-statement .exec(), .get() null→undefined.
 */
export class BunSQLiteAdapter {
  #raw: any;

  constructor(rawDb: any) {
    this.#raw = rawDb;
  }

  pragma(source: string): any {
    const stmt = this.#raw.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (!rows || rows.length === 0) return undefined;
    // Multi-row pragmas (table_xinfo, etc.) → return array
    if (rows.length > 1) return rows;
    // Single-row: extract scalar value (e.g. journal_mode = "wal")
    const values = Object.values(rows[0] as Record<string, unknown>);
    return values.length === 1 ? values[0] : rows[0];
  }

  exec(sql: string): any {
    // bun:sqlite .exec() is single-statement only.
    // Split multi-statement SQL respecting string literals (don't split on ; inside quotes).
    let current = "";
    let inString: string | null = null;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (inString) {
        current += ch;
        if (ch === inString) inString = null;
      } else if (ch === "'" || ch === '"') {
        current += ch;
        inString = ch;
      } else if (ch === ";") {
        const trimmed = current.trim();
        if (trimmed) this.#raw.prepare(trimmed).run();
        current = "";
      } else {
        current += ch;
      }
    }
    const trimmed = current.trim();
    if (trimmed) this.#raw.prepare(trimmed).run();
    return this;
  }

  prepare(sql: string): any {
    const stmt = this.#raw.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => {
        const r = stmt.get(...args);
        return r === null ? undefined : r;
      },
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => stmt.iterate(...args),
    };
  }

  transaction(fn: (...args: any[]) => any): any {
    return this.#raw.transaction(fn);
  }

  close(): void {
    this.#raw.close();
  }
}

// ─────────────────────────────────────────────────────────
// node:sqlite adapter (#228)
// ─────────────────────────────────────────────────────────

/**
 * Wraps node:sqlite's DatabaseSync to provide better-sqlite3-compatible API.
 * Bridges: .pragma(), .transaction(). Everything else is passthrough.
 * Eliminates native addon SIGSEGV on Linux (nodejs/node#62515).
 */
export class NodeSQLiteAdapter {
  #raw: any; // DatabaseSync instance

  constructor(rawDb: any) {
    this.#raw = rawDb;
  }

  pragma(source: string): any {
    // "journal_mode = WAL" → PRAGMA journal_mode = WAL
    // "table_xinfo(session_events)" → PRAGMA table_xinfo(session_events)
    // "wal_checkpoint(TRUNCATE)" → PRAGMA wal_checkpoint(TRUNCATE)
    const stmt = this.#raw.prepare(`PRAGMA ${source}`);
    const rows = stmt.all();
    if (!rows || rows.length === 0) return undefined;
    if (rows.length > 1) return rows;
    const values = Object.values(rows[0] as Record<string, unknown>);
    return values.length === 1 ? values[0] : rows[0];
  }

  exec(sql: string): any {
    // node:sqlite's exec() supports multi-statement natively
    this.#raw.exec(sql);
    return this;
  }

  prepare(sql: string): any {
    const stmt = this.#raw.prepare(sql);
    return {
      run: (...args: unknown[]) => stmt.run(...args),
      get: (...args: unknown[]) => stmt.get(...args),
      all: (...args: unknown[]) => stmt.all(...args),
      iterate: (...args: unknown[]) => {
        // node:sqlite uses Symbol.iterator on StatementSync, not .iterate()
        // Check if iterate exists, otherwise use Symbol.iterator
        if (typeof stmt.iterate === 'function') {
          return stmt.iterate(...args);
        }
        // Fallback: use all() to create an iterator
        const rows = stmt.all(...args);
        return rows[Symbol.iterator]();
      },
    };
  }

  transaction(fn: (...args: any[]) => any): any {
    // node:sqlite has no transaction() method — manual BEGIN/COMMIT/ROLLBACK.
    // Mirrors better-sqlite3's/bun:sqlite's .deferred()/.immediate()/
    // .exclusive() sub-functions on the returned callable so ADR-0001
    // multi-writer call sites (ContentStore, SessionDB) can request
    // `BEGIN IMMEDIATE` without branching on which SQLite backend loaded.
    const run = (beginStmt: string) => (...args: any[]) => {
      this.#raw.exec(beginStmt);
      try {
        const result = fn(...args);
        this.#raw.exec("COMMIT");
        return result;
      } catch (err) {
        this.#raw.exec("ROLLBACK");
        throw err;
      }
    };
    const deferred: any = run("BEGIN DEFERRED");
    deferred.deferred = deferred;
    deferred.immediate = run("BEGIN IMMEDIATE");
    deferred.exclusive = run("BEGIN EXCLUSIVE");
    return deferred;
  }

  close(): void {
    this.#raw.close();
  }
}

// ─────────────────────────────────────────────────────────
// Lazy loader
// ─────────────────────────────────────────────────────────

let _Database: typeof DatabaseConstructor | null = null;

/**
 * Probe whether the supplied node:sqlite DatabaseSync constructor links a
 * SQLite build that includes the FTS5 module. Some Node.js Linux builds
 * (e.g. v22.14.0 on Ubuntu) ship node:sqlite without FTS5 even though the
 * import succeeds, which silently breaks ctx_search/ctx_batch_execute and
 * the doctor's FTS5 check (issue #461).
 *
 * Returns true only when a `CREATE VIRTUAL TABLE … USING fts5(x)` statement
 * succeeds. Always returns false on any failure (constructor throw, missing
 * module, etc.) so the caller can fall through to better-sqlite3, whose
 * bundled SQLite always ships with FTS5.
 */
export function nodeSqliteHasFts5(DatabaseSync: any): boolean {
  let probe: any = null;
  try {
    probe = new DatabaseSync(":memory:");
    probe.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");
    return true;
  } catch {
    return false;
  } finally {
    try { probe?.close(); } catch { /* probe never opened or already closed */ }
  }
}

/**
 * Returns true when the current runtime ships a built-in SQLite binding:
 * - Bun has `bun:sqlite` always
 * - Node has `node:sqlite` since 22.5 (no flag since 22.13)
 *
 * Mirrors the helper in hooks/ensure-deps.mjs:61. Exported so the platform
 * gate in loadDatabase() can be unit-tested without spawning a child
 * process. `versionsOverride` and `bunOverride` are injection points for
 * tests — production callers pass nothing.
 *
 * Widening the gate from `process.platform === "linux"` to this helper is
 * required for Node 26 on macOS arm64 (#551): Node 26 removed
 * `info.This()` from V8 PropertyCallbackInfo, breaking better-sqlite3
 * 12.9.0's native compile. Using node:sqlite sidesteps the native addon
 * entirely on every platform that has it.
 */
export function hasModernSqlite(
  versionsOverride?: NodeJS.ProcessVersions,
  bunOverride?: unknown,
): boolean {
  const bun = bunOverride !== undefined ? bunOverride : (globalThis as any).Bun;
  if (typeof bun !== "undefined" && bun !== null) return true;
  const versions = versionsOverride ?? process.versions;
  const [majorStr, minorStr] = (versions.node ?? "0.0.0").split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 22 || (major === 22 && minor >= 5);
}

/**
 * Lazy-load the SQLite driver for the current runtime.
 * Bun → bun:sqlite via BunSQLiteAdapter (issue #45).
 * Modern Node (>= 22.5) → node:sqlite via NodeSQLiteAdapter when it ships FTS5 (#228, #461, #551).
 * Other Node (or modern Node without FTS5) → better-sqlite3 (native addon).
 */
export function loadDatabase(): typeof DatabaseConstructor {
  if (!_Database) {
    const require = createRequire(import.meta.url);

    if ((globalThis as any).Bun) {
      // Bun runtime — use bun:sqlite directly.
      // Array.join() prevents esbuild from resolving the specifier at bundle time.
      const BunDB = require(["bun", "sqlite"].join(":")).Database;
      _Database = function BunDatabaseFactory(path: string, opts?: any) {
        const raw = new BunDB(path, {
          readonly: opts?.readonly,
          create: true,
        });
        const adapter = new BunSQLiteAdapter(raw);
        // Propagate busy_timeout — better-sqlite3 does this via constructor
        // option but bun:sqlite does not, so we set it via pragma (#243)
        if (opts?.timeout) {
          adapter.pragma(`busy_timeout = ${opts.timeout}`);
        }
        return adapter;
      } as any;
    } else if (hasModernSqlite()) {
      // Any Node >= 22.5 — try node:sqlite to avoid the native addon path
      // entirely. Historically this was Linux-only (avoiding the Linux
      // SIGSEGV per nodejs/node#62515, #228), but Node 26 also broke
      // better-sqlite3's native compile on macOS arm64 by removing
      // V8 `info.This()` (#551). The built-in `node:sqlite` ships its
      // own SQLite, so it sidesteps both issues at once.
      //
      // Probe FTS5 support before committing — some Node builds ship
      // node:sqlite without FTS5, which would silently break ctx_search
      // (#461). The probe runs at most once per process (cached via
      // _Database below), so the cost of an in-memory DatabaseSync is
      // negligible.
      let DatabaseSync: any = null;
      try {
        // Array.join() prevents esbuild from resolving the specifier at bundle time
        // (mirrors the bun:sqlite branch above).
        ({ DatabaseSync } = require(["node", "sqlite"].join(":")));
      } catch {
        DatabaseSync = null;
      }
      if (DatabaseSync && nodeSqliteHasFts5(DatabaseSync)) {
        _Database = function NodeDatabaseFactory(path: string, opts?: any) {
          const raw = new DatabaseSync(path, {
            readOnly: opts?.readonly ?? false,
          });
          const adapter = new NodeSQLiteAdapter(raw);
          // Propagate busy_timeout — node:sqlite's DatabaseSync constructor
          // silently ignores `{ timeout }` (unlike better-sqlite3's native
          // C++ constructor), so we set it via PRAGMA, mirroring the Bun
          // branch above. Without this, the default is 0 and the first
          // write contention surfaces as immediate `SQLITE_BUSY`/`database
          // is locked` — defeating the 30s grace `withRetry()` is built
          // around. See issue #642 and ADR-0001 (multi-writer contract).
          if (opts?.timeout) {
            adapter.pragma(`busy_timeout = ${opts.timeout}`);
          }
          return adapter;
        } as any;
      } else {
        // node:sqlite missing or built without FTS5 — fall through to
        // better-sqlite3. Trade-off: on Node 26 + macOS this may now hit
        // the V8 ABI break (#551). A visible crash on the rare
        // unstable build is preferable to silent "no such module: fts5"
        // on every ctx_search call.
        _Database = require("better-sqlite3") as typeof DatabaseConstructor;
      }
    } else {
      // Old Node (< 22.5) without bun:sqlite — fall back to better-sqlite3.
      _Database = require("better-sqlite3") as typeof DatabaseConstructor;
    }
  }
  return _Database!;
}

// ─────────────────────────────────────────────────────────
// WAL setup
// ─────────────────────────────────────────────────────────

/**
 * Apply WAL mode and NORMAL synchronous pragma to a database instance.
 * Should be called immediately after opening a new database connection.
 *
 * WAL mode provides:
 * - Concurrent readers while a write is in progress
 * - Dramatically faster writes (no full-page sync on each commit)
 * NORMAL synchronous is safe under WAL and avoids an extra fsync per
 * transaction.
 */
export function applyWALPragmas(db: DatabaseInstance): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // mmap_size is opt-in (CONTEXT_MODE_MMAP_SIZE=<bytes>), default off.
  // This helper is shared by ContentStore and SessionDB, both GLOBAL
  // multi-writer stores in this fork (see maint/global-store): sibling
  // server processes across profiles/projects hold live connections to
  // the SAME files and can rename/delete/recreate them on corruption
  // recovery or stale cleanup (renameCorruptDB, deleteDBFiles). Under
  // mmap, a fault on a replaced or truncated mapping cannot be handled
  // by SQLite — it surfaces as an uncatchable signal rather than a
  // catchable error (sqlite.org/mmap.html, disadvantage 1) — and Windows
  // cannot truncate a memory-mapped file at all (disadvantage 4). That
  // hazard is more likely here than upstream, since our global store
  // makes multi-process access to the same file the normal case, not
  // the exception. Set CONTEXT_MODE_MMAP_SIZE to re-enable the read()
  // bypass for single-process, read-heavy workloads.
  // Adopted from upstream PR #1056 by @HyeokjaeLee.
  const mmapSize = Number(process.env.CONTEXT_MODE_MMAP_SIZE ?? "0");
  if (Number.isFinite(mmapSize) && mmapSize > 0) {
    try { db.pragma(`mmap_size = ${mmapSize}`); } catch { /* unsupported runtime */ }
  }
  // NOTE: `locking_mode = EXCLUSIVE` is intentionally NOT applied here.
  // ALL DBs built on this helper — ContentStore (FTS5 shared knowledge
  // base) AND SessionDB (per-project events) — are multi-writer-safe by
  // contract. WAL + busy_timeout + the withRetry() wrapper below handle
  // SQLITE_BUSY natively. EXCLUSIVE locking is opt-out, never opt-in
  // from a base class shared by multi-writer consumers.
  // See docs/adr/0001-sessiondb-multi-writer.md for the v1.0.130 ADR.
}

/**
 * Start a periodic PASSIVE WAL checkpoint on `db`, returning a stop function.
 * Design and implementation from upstream PR #988 by @alove20 (issue #985).
 *
 * `closeDB()` no longer issues a manual checkpoint (see its doc comment —
 * adopted from upstream PR #1056), so this timer is now the ONLY explicit
 * WAL-bounding path for a long-lived process; SQLite's own last-connection
 * checkpoint still runs on graceful close, but a server killed hard (crash,
 * reboot, SIGKILL, or a Windows parent-death before the lifecycle guard
 * fires) never reaches even that, so under multi-session load a shared
 * store's WAL can grow unbounded (a real-world install was observed at
 * 19.7MB). A PASSIVE checkpoint reclaims whatever WAL frames it can between
 * reader gaps; it never blocks and touches no locking, so it stays within
 * ADR-0001's multi-writer contract (no EXCLUSIVE, no lockfile).
 *
 * Time-based rather than write-count-based on purpose: a count-based
 * trigger never fires again once a session goes idle mid-count, leaving an
 * unbounded WAL behind for exactly the idle-but-alive sessions a shared
 * global store makes common. The timer is `.unref()`'d so it never keeps
 * the event loop alive. A non-positive or non-finite interval disables it
 * and returns a no-op stopper.
 */
export function startWalCheckpointTimer(
  db: DatabaseInstance,
  intervalMs: number,
): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {};
  const timer = setInterval(() => {
    try {
      db.pragma("wal_checkpoint(PASSIVE)");
    } catch {
      /* best-effort — a busy or closing DB just retries next tick */
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ─────────────────────────────────────────────────────────
// DB file helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove orphaned WAL/SHM files when the main DB file doesn't exist.
 * On Windows, stale -wal/-shm files from crashed processes cause
 * "file is not a database" errors when creating a fresh DB.
 */
export function cleanOrphanedWALFiles(dbPath: string): void {
  if (!existsSync(dbPath)) {
    for (const suffix of ["-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  }
}

/**
 * Delete all three SQLite files for a given db path (main, WAL, SHM).
 * Silently ignores individual deletion errors so a partial cleanup
 * does not abort the rest.
 */
export function deleteDBFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(dbPath + suffix);
    } catch {
      // ignore — file may not exist
    }
  }
}

/**
 * Safely close a database connection. Swallows errors so callers can
 * always call this in a finally/cleanup path without try/catch.
 *
 * No manual wal_checkpoint(TRUNCATE) is issued here. This helper serves
 * GLOBAL multi-writer stores (ContentStore, SessionDB — see
 * maint/global-store): every close used to TRUNCATE the shared WAL and
 * reset the wal-index while sibling server processes across profiles held
 * live connections — a cross-process file mutation implicated in
 * permanent SQLITE_IOERR wedges. It was also redundant: SQLite
 * auto-checkpoints once the WAL hits 1000 pages, and the LAST connection
 * to close runs its own checkpoint and deletes -wal/-shm
 * (sqlite.org/wal.html sections 3.1 and 6). Bounding WAL growth on
 * hard-exit paths (where the last close never happens) is what the
 * periodic PASSIVE timer (startWalCheckpointTimer, #985/#988) is for —
 * callers stop that timer before calling closeDB so the two never
 * checkpoint concurrently.
 * Adopted from upstream PR #1056 by @HyeokjaeLee.
 */
export function closeDB(db: DatabaseInstance): void {
  try {
    db.close();
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────
// Default path helper
// ─────────────────────────────────────────────────────────

/**
 * Return the default per-process DB path for context-mode databases.
 * Uses the OS temp directory and embeds the current PID so multiple
 * server instances never share a file.
 */
export function defaultDBPath(prefix: string = "context-mode"): string {
  return join(tmpdir(), `${prefix}-${process.pid}.db`);
}

// ─────────────────────────────────────────────────────────
// Retry helper
// ─────────────────────────────────────────────────────────

// Backing buffer for the blocking-sleep trick below. A single shared Int32Array
// slot that is never notified, so Atomics.wait() simply blocks the calling
// thread for the timeout -- a synchronous sleep with no CPU spin. Module-level
// singleton: the buffer's contents are never read, only used as a wait target.
const _sleepBuf = new Int32Array(new SharedArrayBuffer(4));

/**
 * Synchronously block the CURRENT thread for `ms` milliseconds without
 * spinning the CPU. Replaces a `while (Date.now() - start < delay) {}`
 * busy-wait (upstream issue #985 / PR #986) -- under real multi-writer
 * contention that spin pins a core per waiting connection and starves the
 * writer it's waiting on. `Atomics.wait` parks the thread with the OS
 * scheduler instead.
 *
 * Only valid off the main thread's microtask assumptions -- fine here since
 * withRetry() is used from synchronous better-sqlite3/bun:sqlite/node:sqlite
 * call sites, which block the event loop for the duration of the query
 * anyway.
 */
function blockingSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(_sleepBuf, 0, 0, ms);
}

/**
 * Error substrings that indicate a *transient* SQLite failure worth
 * retrying: lock contention (SQLITE_BUSY) and transient I/O errors
 * (SQLITE_IOERR / "disk I/O error" -- issues #992, #1030; PR #1030 by
 * @halindrome). SQLITE_IOERR is deliberately included: filesystem
 * pressure, a WAL hiccup, or a network/shared-filesystem blip previously
 * fell into a gap here (no retry) and were also not corruption (no
 * recovery via isSQLiteCorruptionError either), so one I/O stall
 * hard-failed the caller. Corruption errors (SQLITE_CORRUPT, SQLITE_NOTADB)
 * are NOT included here -- those need isSQLiteCorruptionError's
 * rename-and-recreate path, not a retry.
 */
const TRANSIENT_ERROR_PATTERNS = [
  "SQLITE_BUSY",
  "database is locked",
  "SQLITE_IOERR",
  "disk I/O error",
];

function isRetryableDbError(msg: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Retry a DB operation with exponential backoff on transient SQLITE_BUSY /
 * SQLITE_IOERR errors. Retries up to 3 times with delays: 100ms, 500ms,
 * 2000ms, blocking synchronously between attempts (see `blockingSleep`)
 * rather than busy-waiting. If all retries fail, throws a descriptive
 * error naming the actual class of failure exhausted (reporting "database
 * is locked" for an I/O failure would send the caller after the wrong root
 * cause). Pass custom delays for testing (e.g., [0, 0, 0] to skip waits).
 *
 * When a `heal` callback is provided AND the caught error matches the
 * SQLite-corruption predicate (SQLITE_CORRUPT / disk image is malformed /
 * file is not a database), the callback is invoked before the retry so the
 * caller can close the held connection, heal the on-disk file, and reopen.
 * The retry then goes through the full transient-retry loop so lock
 * contention on the healed DB does not fail the operation. Covers
 * mid-session corruption on a long-held handle (ContentStore, SessionDB) -
 * the open-time guard alone misses it (adopted from upstream #871, #867).
 * The healed retry deliberately passes no `heal` callback, so a DB that
 * re-corrupts cannot drive an unbounded heal loop.
 */
export function withRetry<T>(
  fn: () => T,
  delays: number[] = [100, 500, 2000],
  heal?: () => boolean,
): T {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg) && heal) {
        if (heal()) {
          try {
            return withRetry(fn, delays);
          } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            throw new Error(
              `Write failed after corruption heal: ${retryMsg}. Original corruption: ${msg}`
            );
          }
        }
        // heal failed - fall through and throw the original corruption error
      }
      if (!isRetryableDbError(msg)) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(msg);
      if (attempt < delays.length) {
        blockingSleep(delays[attempt]);
      }
    }
  }
  const failure = lastError?.message ?? "";
  const cause = failure.includes("SQLITE_IOERR") || failure.includes("disk I/O error")
    ? "SQLITE_IOERR: disk I/O error"
    : "SQLITE_BUSY: database is locked";
  throw new Error(
    `${cause} after ${delays.length} retries. ` +
    `Original error: ${lastError?.message}`
  );
}

// ─────────────────────────────────────────────────────────
// Corrupt DB recovery (#244)
// ─────────────────────────────────────────────────────────

/**
 * Detect SQLite corruption errors that warrant a rename-and-recreate.
 * Matches SQLITE_CORRUPT, SQLITE_NOTADB, and their human-readable equivalents.
 */
export function isSQLiteCorruptionError(msg: string): boolean {
  return (
    msg.includes("SQLITE_CORRUPT") ||
    msg.includes("SQLITE_NOTADB") ||
    msg.includes("database disk image is malformed") ||
    msg.includes("file is not a database")
  );
}

/**
 * Rename a corrupt DB and its WAL/SHM files so a fresh DB can be created.
 * Best-effort — individual rename failures are silently ignored.
 */
export function renameCorruptDB(dbPath: string): void {
  const ts = Date.now();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      renameSync(dbPath + suffix, `${dbPath}${suffix}.corrupt-${ts}`);
    } catch { /* file may not exist */ }
  }
}

/**
 * Best-effort lossless heal of a corrupt SQLite database via
 * VACUUM INTO -> integrity check -> atomic swap (adopted from upstream #871, #867).
 *
 * Opens a read-only connection on the corrupt file, runs `VACUUM INTO '<tmp>'`
 * to rebuild a clean copy (data-preserving when corruption is confined to
 * freelist/indexes — the common mid-session case, not guaranteed when the
 * b-tree itself is damaged), then verifies the result with `PRAGMA quick_check`
 * before atomically swapping the healed file in place.
 *
 * Returns `true` on success, `false` if the file is too damaged even for a
 * readonly open, VACUUM INTO throws, or quick_check does not return "ok" —
 * caller should fall back to `renameCorruptDB` + recreate-empty.
 */
export function attemptLosslessHeal(dbPath: string): boolean {
  const Database = loadDatabase();
  const tmpPath = `${dbPath}.heal-${Date.now()}`;
  try {
    const src = new Database(dbPath, { readonly: true });
    try {
      src.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
      try { src.close(); } catch { /* ignore */ }
    }

    // prepare().get() rather than pragma() — adapters disagree on the
    // return shape, but prepare('PRAGMA quick_check').get() is consistent.
    const healed = new Database(tmpPath, { readonly: true });
    let ok = false;
    try {
      const row = healed.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
      ok = row?.quick_check === "ok";
    } catch { /* quick_check threw — heal failed */ }
    try { healed.close(); } catch { /* ignore */ }
    if (!ok) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      return false;
    }

    const backupPath = `${dbPath}.corrupt-${Date.now()}`;
    renameSync(dbPath, backupPath);
    renameSync(tmpPath, dbPath);
    for (const s of ["-wal", "-shm"]) {
      try { unlinkSync(backupPath + s); } catch { /* ignore */ }
    }
    return true;
  } catch {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Close a held DB handle, heal (or rename) the on-disk file, and reopen
 * with fresh schema + statements via `onReopen` (adopted from upstream #871, #867).
 * Shared by SQLiteBase and ContentStore, which both need the same
 * heal-then-reopen sequence on mid-session corruption.
 */
export function reopenAfterHeal(
  dbPath: string,
  oldDb: DatabaseInstance,
  onReopen: (db: DatabaseInstance) => void,
): DatabaseInstance {
  try { oldDb.close(); } catch { /* already closed or damaged */ }

  if (!attemptLosslessHeal(dbPath)) {
    renameCorruptDB(dbPath);
  }

  const Database = loadDatabase();
  const newDb = new Database(dbPath, { timeout: 30000 });
  applyWALPragmas(newDb);
  onReopen(newDb);
  return newDb;
}

// ─────────────────────────────────────────────────────────
// maint/global-store — cross-profile legacy DB adoption
// ─────────────────────────────────────────────────────────

/**
 * One-shot migration for the move from per-profile storage to a single
 * global store. Before this fix, the SAME project got a SEPARATE content/
 * session DB under each host profile (`~/.claude`, `~/.claude-ime`,
 * `~/.claude-devcom`, ...) because storage was rooted at the profile's own
 * config dir. Now that storage resolves to one global root
 * (resolveContextModeDataRoot, src/adapters/base.ts), a project opened for
 * the first time under the new root would otherwise start with an EMPTY
 * database even though a profile-scoped one already has months of history.
 *
 * If `newDbPath` doesn't exist yet, scans every dot-directory directly
 * under `homedir()` (the legacy `~/.claude*`, `~/.codex`, `~/.cursor`, ...
 * profile roots - kept as a generic dotfile scan, not a fixed name list, so
 * arbitrary user-chosen `CLAUDE_CONFIG_DIR` profile names like
 * `~/.claude-ime` are still found), PLUS the two-level legacy roots in
 * `LEGACY_ADAPTER_HOME_SEGMENTS` (src/session/data-root.ts - shared with
 * `enumerateAdapterDirs`) that the one-level scan can't reach
 * (`~/.config/opencode`, `~/.config/JetBrains`, `~/.config/kilo`,
 * `~/.config/zed`), for `<root>/context-mode/<subdir>/<fileName>`, and
 * adopts the LARGEST match by file size (the most complete history) by
 * COPYING it into place — legacy files are never deleted, per the "never
 * delete old files" requirement. Does NOT cover vscode-copilot's
 * project-relative `.github/context-mode/...` store (no home-relative path
 * exists for it) or any store relocated via a config-dir env var
 * (`CODEX_HOME`, `COPILOT_HOME`, `KIMI_CODE_HOME`, `GEMINI_CLI_HOME`, ...)
 * outside `$HOME` - both are phase 2 work, see
 * docs/plan-store-unification.md.
 *
 * Concurrency: safe when several sessions start simultaneously. Both the
 * existence check and the final placement race, but every racer computes
 * the same "largest legacy file" deterministically from the same
 * read-only scan, copies it to a PID+timestamp-unique temp file beside the
 * destination, then `renameSync`s into place. Same-directory rename is
 * atomic on both POSIX and Windows (NTFS), so whichever racer renames last
 * simply overwrites an equivalent copy — never a partial or corrupt file.
 * A racer that loses the rename (destination already claimed) removes its
 * own temp file and returns whether the destination now exists.
 *
 * Returns true if a legacy DB was adopted (or already had been by a
 * concurrent racer), false if there was nothing to adopt.
 */
export function adoptLargestLegacyDb(opts: {
  newDbPath: string;
  /** "content" or "sessions" — the subdir under <profile>/context-mode/. */
  subdir: string;
  /** Basename to look for, e.g. `${projectHash}.db`. */
  fileName: string;
  log?: (message: string) => void;
}): boolean {
  const { newDbPath, subdir, fileName, log } = opts;
  if (existsSync(newDbPath)) return false;

  let home: string;
  let entries: string[];
  try {
    home = homedir();
    entries = readdirSync(home);
  } catch {
    return false;
  }

  // Candidate roots: every dotfile directly under homedir() (kept generic,
  // not driven off a fixed name list, so it still catches arbitrary
  // CLAUDE_CONFIG_DIR profile names like .claude-ime/.claude-devcom, which
  // are user-chosen and can't be enumerated up front), PLUS the two-level
  // legacy roots in LEGACY_ADAPTER_HOME_SEGMENTS (src/session/data-root.ts -
  // shared with enumerateAdapterDirs) that the one-level scan structurally
  // cannot reach (.config/opencode, .config/JetBrains, .config/kilo,
  // .config/zed). Does NOT cover vscode-copilot's project-relative .github
  // store or any store relocated via a config-dir env var (CODEX_HOME,
  // COPILOT_HOME, ...) outside $HOME - both are phase 2 work
  // (docs/plan-store-unification.md).
  const candidates: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(".")) continue; // profile dirs are all dotfiles (.claude, .codex, ...)
    candidates.push(join(home, entry, "context-mode", subdir, fileName));
  }
  for (const [, segments] of LEGACY_ADAPTER_HOME_SEGMENTS) {
    if (segments.length < 2) continue; // already covered by the one-level scan above
    candidates.push(join(home, ...segments, "context-mode", subdir, fileName));
  }

  const found: Array<{ path: string; size: number }> = [];
  for (const candidate of candidates) {
    let st;
    try {
      st = statSync(candidate);
    } catch {
      continue; // not present under this legacy root
    }
    if (!st.isFile()) continue;
    found.push({ path: candidate, size: st.size });
  }
  if (found.length === 0) return false;

  let best = found[0];
  for (const candidate of found) {
    if (candidate.size > best.size) best = candidate;
  }

  // More than one legacy copy exists for this project: the largest-wins
  // adoption below silently discards the rest, which is exactly the kind of
  // divergence that went unnoticed for months (see
  // docs/plan-store-unification.md). Surface it so it isn't invisible again.
  if (found.length > 1) {
    const discarded = found.filter((c) => c.path !== best.path).map((c) => `${c.path} (${c.size} bytes)`);
    log?.(
      `context-mode: multiple legacy DBs found for ${fileName} - adopting ${best.path} (${best.size} bytes), ` +
        `NOT adopting: ${discarded.join(", ")}. Run scripts/merge-stores.ts to merge them instead of discarding.`,
    );
  }

  try {
    mkdirSync(dirname(newDbPath), { recursive: true });
    // Copy the main file plus any WAL/SHM sidecars so an active
    // not-yet-checkpointed WAL isn't silently dropped by the migration.
    for (const suffix of ["", "-wal", "-shm"]) {
      const src = best.path + suffix;
      if (!existsSync(src)) continue;
      const tmp = `${newDbPath}${suffix}.adopting-${process.pid}-${Date.now()}`;
      try {
        copyFileSync(src, tmp);
        renameSync(tmp, newDbPath + suffix);
      } catch {
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
    }
  } catch {
    return existsSync(newDbPath); // best-effort — a concurrent racer may have won
  }

  if (existsSync(newDbPath)) {
    log?.(`context-mode: adopted legacy DB ${best.path} (${best.size} bytes) -> ${newDbPath}`);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────
// Base class
// ─────────────────────────────────────────────────────────

/**
 * SQLiteBase — minimal base class that handles open/close/cleanup lifecycle.
 *
 * Subclasses call `super(dbPath)` to open the database with WAL pragmas
 * applied, then implement `initSchema()` and `prepareStatements()`.
 *
 * The `db` getter exposes the raw `DatabaseInstance` to subclasses only.
 */
/**
 * Track all live DatabaseInstance objects so we can close them on process exit.
 * Prevents better-sqlite3 segfaults caused by V8 garbage-collecting Database
 * objects after the native addon context is already torn down.
 *
 * Uses a global symbol so the set and exit handler survive vitest's module
 * re-imports within the same fork process (ESM isolate mode clears
 * module-level state but globalThis persists).
 */
// v1.0.130 — symbol name bumped because the value type reverted from
// Map<DatabaseInstance, string> (v1.0.128 lockfile pairing) back to
// Set<DatabaseInstance>. A persistent global slot from a v1.0.128 or
// v1.0.129 module would deserialize as the wrong shape and crash the
// exit hook iteration.
const _kLiveDBs = Symbol.for("__context_mode_live_dbs_v3__");
const _liveDBs: Set<DatabaseInstance> = (() => {
  const g = globalThis as Record<symbol, Set<DatabaseInstance> | undefined>;
  if (!g[_kLiveDBs]) {
    g[_kLiveDBs] = new Set<DatabaseInstance>();
    process.on("exit", () => {
      for (const db of g[_kLiveDBs]!) {
        closeDB(db);
      }
      g[_kLiveDBs]!.clear();
    });
  }
  return g[_kLiveDBs]!;
})();

export abstract class SQLiteBase {
  readonly #dbPath: string;
  #db: DatabaseInstance;

  /**
   * Open (or create) a SQLite DB at `dbPath`.
   *
   * v1.0.130 — multi-writer is the contract. ALL SQLiteBase consumers
   * (SessionDB, ContentStore) may open the same on-disk dbPath from
   * multiple processes simultaneously — that is the legitimate multi-
   * window UX shape and the WAL handles it natively. SQLITE_BUSY on
   * write contention is absorbed by `withRetry()` below (busy_timeout
   * = 30000ms inside `new Database(...)`).
   *
   * v1.0.128 introduced a single-writer guard here as a defense against
   * #560. That defense was an over-correction — the actual root causes
   * of #560 were #559 (zombie MCP child accumulation) and #561 (Pi
   * misdetection writing to the wrong DB path), both fixed in v1.0.128
   * + v1.0.129. The single-writer guard broke legitimate multi-window
   * users; v1.0.130 rolls it out. See
   * docs/adr/0001-sessiondb-multi-writer.md and the v1.0.130 INVARIANT
   * block in tests/util/db-base-platform-gate.test.ts for the
   * regression-proof anchor (source-pin + behavioural).
   */
  constructor(dbPath: string) {
    const Database = loadDatabase();
    this.#dbPath = dbPath;
    cleanOrphanedWALFiles(dbPath);
    let db: DatabaseInstance;
    try {
      db = new Database(dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        renameCorruptDB(dbPath);
        cleanOrphanedWALFiles(dbPath);
        try {
          db = new Database(dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after renaming corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    _liveDBs.add(this.#db);
    this.initSchema();
    this.prepareStatements();
  }

  /** Called once after WAL pragmas are applied. Subclasses run CREATE TABLE/VIRTUAL TABLE here. */
  protected abstract initSchema(): void;

  /** Called once after schema init. Subclasses compile and cache their prepared statements here. */
  protected abstract prepareStatements(): void;

  /** Raw database instance — available to subclasses only. */
  protected get db(): DatabaseInstance {
    return this.#db;
  }

  /** The path this database was opened from. */
  get dbPath(): string {
    return this.#dbPath;
  }

  /** Close the database connection without deleting files. */
  close(): void {
    _liveDBs.delete(this.#db);
    closeDB(this.#db);
  }

  protected withRetry<T>(fn: () => T): T {
    return withRetry(fn, undefined, () => this.#healAndReopen());
  }

  /**
   * Heal a mid-session corrupt DB: close the held handle, attempt lossless
   * recovery, reopen, and re-init schema + prepared statements so the next
   * write retry operates on a healthy connection (adopted from upstream #871, #867).
   */
  #healAndReopen(): boolean {
    _liveDBs.delete(this.#db);
    this.#db = reopenAfterHeal(this.#dbPath, this.#db, () => {
      this.initSchema();
      this.prepareStatements();
    });
    _liveDBs.add(this.#db);
    return true;
  }

  /**
   * Close the connection and delete all associated DB files (main, WAL, SHM).
   * Call on process exit or at end of session lifecycle.
   */
  cleanup(): void {
    _liveDBs.delete(this.#db);
    closeDB(this.#db);
    deleteDBFiles(this.#dbPath);
  }
}
