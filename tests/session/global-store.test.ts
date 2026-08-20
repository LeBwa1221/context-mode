/**
 * maint/global-store — regression tests for the global (not per-profile)
 * context-mode data store.
 *
 * Before this fix, the SAME project got a SEPARATE, divergent knowledge
 * base per host profile (~/.claude, ~/.claude-ime, ~/.claude-devcom, ...)
 * because storage resolved relative to the profile's own config dir.
 * Covers:
 *   1. resolveContextModeDataRoot() precedence (CONTEXT_MODE_HOME >
 *      CONTEXT_MODE_DATA_DIR > OS-appropriate global default).
 *   2. One project resolves to ONE db regardless of CLAUDE_CONFIG_DIR.
 *   3. adoptLargestLegacyDb() migrates the largest pre-existing
 *      per-profile DB into the new global location.
 *   4. Concurrency: N connections writing to the same DB simultaneously
 *      lose no writes and don't throw SQLITE_BUSY.
 */
import "../setup-home";
import { fakeHome } from "../setup-home";
import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { resolveContextModeDataRoot } from "../../src/adapters/base.js";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code/index.js";
import { adoptLargestLegacyDb } from "../../src/db-base.js";
import {
  hashProjectDirCanonical,
  resolveContentStorePath,
  resolveDefaultSessionDir,
  resolveSessionDbPath,
  resolveSessionStorageDir,
  SessionDB,
} from "../../src/session/db.js";

const cleanup: string[] = [];
afterEach(() => {
  delete process.env.CONTEXT_MODE_HOME;
  delete process.env.CONTEXT_MODE_DATA_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
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

// ─────────────────────────────────────────────────────────
// 1. Root resolution precedence
// ─────────────────────────────────────────────────────────

describe("resolveContextModeDataRoot precedence", () => {
  it("CONTEXT_MODE_HOME wins over everything else", () => {
    const custom = tempDir("ctx-home-");
    process.env.CONTEXT_MODE_HOME = custom;
    process.env.CONTEXT_MODE_DATA_DIR = tempDir("ctx-data-dir-ignored-");
    expect(resolveContextModeDataRoot()).toBe(custom);
  });

  it("falls back to CONTEXT_MODE_DATA_DIR (#649 alias) when CONTEXT_MODE_HOME is unset", () => {
    const custom = tempDir("ctx-data-dir-");
    delete process.env.CONTEXT_MODE_HOME;
    process.env.CONTEXT_MODE_DATA_DIR = custom;
    expect(resolveContextModeDataRoot()).toBe(custom);
  });

  it("falls back to the OS-appropriate global default when neither env is set", () => {
    delete process.env.CONTEXT_MODE_HOME;
    delete process.env.CONTEXT_MODE_DATA_DIR;
    const root = resolveContextModeDataRoot();
    // Built from homedir() (mocked to fakeHome by setup-home) — never
    // returns null, and never falls back to a profile-rooted path
    // (that fallback is exactly the multi-profile bug this replaces).
    expect(root.startsWith(fakeHome)).toBe(true);
    expect(root).not.toContain(".claude");
  });

  it("treats an empty/whitespace CONTEXT_MODE_HOME as unset (safety guard)", () => {
    process.env.CONTEXT_MODE_HOME = "   ";
    const root = resolveContextModeDataRoot();
    expect(root.startsWith(fakeHome)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// 2. One project -> one DB regardless of CLAUDE_CONFIG_DIR
// ─────────────────────────────────────────────────────────

describe("one project resolves to ONE db regardless of CLAUDE_CONFIG_DIR", () => {
  it("ClaudeCodeAdapter.getSessionDir() is unaffected by switching CLAUDE_CONFIG_DIR profiles", () => {
    const adapter = new ClaudeCodeAdapter();

    delete process.env.CLAUDE_CONFIG_DIR;
    const baseline = adapter.getSessionDir();

    for (const profile of [".claude-ime", ".claude-devcom", ".claude-personal"]) {
      process.env.CLAUDE_CONFIG_DIR = join(fakeHome, profile);
      expect(adapter.getSessionDir()).toBe(baseline);
    }
  });

  it("resolveSessionDbPath for a fixed projectDir is identical across simulated profile switches", () => {
    const adapter = new ClaudeCodeAdapter();
    const projectDir = join(fakeHome, "some-project");

    const paths = [".claude", ".claude-ime", ".claude-devcom"].map((profile) => {
      process.env.CLAUDE_CONFIG_DIR = join(fakeHome, profile);
      return resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() });
    });

    expect(new Set(paths).size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────
// 2b. Hooks path == adapter path (HANDOFF.md item 6 / maint/integration)
//
// The tests above only cover the adapter half (ClaudeCodeAdapter.getSessionDir,
// which already routed through resolveContextModeDataRoot). Hooks reach
// storage through a different call chain -
// resolveSessionStorageDir(() => resolveDefaultSessionDir(...)), as
// hooks/session-helpers.mjs's resolveSessionDir does - and resolveDefaultSessionDir
// used to build a profile-scoped path from configDir/CLAUDE_CONFIG_DIR
// instead of the shared global root. That gap is why the divergence in
// HANDOFF.md item 6 survived a suite written to prevent exactly it.
// ─────────────────────────────────────────────────────────

describe("hooks path resolves to the same directory as the adapter path", () => {
  it("resolveDefaultSessionDir (hooks) matches ClaudeCodeAdapter.getSessionDir() (server)", () => {
    delete process.env.CLAUDE_CONFIG_DIR;

    const adapterDir = new ClaudeCodeAdapter().getSessionDir();
    const hooksDir = resolveSessionStorageDir(() =>
      resolveDefaultSessionDir({ configDir: ".claude", configDirEnv: "CLAUDE_CONFIG_DIR" }),
    ).path;

    expect(hooksDir).toBe(adapterDir);
  });

  it("stays identical across simulated profile switches, matching the adapter path", () => {
    const adapterDir = new ClaudeCodeAdapter().getSessionDir();

    for (const profile of [".claude-ime", ".claude-devcom", ".claude-personal"]) {
      process.env.CLAUDE_CONFIG_DIR = join(fakeHome, profile);
      const hooksDir = resolveSessionStorageDir(() =>
        resolveDefaultSessionDir({ configDir: ".claude", configDirEnv: "CLAUDE_CONFIG_DIR" }),
      ).path;
      expect(hooksDir).toBe(adapterDir);
    }
  });
});

// ─────────────────────────────────────────────────────────
// 3. Migration adopts the largest legacy DB
// ─────────────────────────────────────────────────────────

describe("adoptLargestLegacyDb", () => {
  function makeLegacyDb(profileDirName: string, subdir: string, fileName: string, content: string): string {
    const dir = join(fakeHome, profileDirName, "context-mode", subdir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, fileName);
    writeFileSync(path, content);
    cleanup.push(join(fakeHome, profileDirName));
    return path;
  }

  it("adopts the LARGEST legacy DB across profiles, leaving the others untouched", () => {
    const fileName = "abc123.db";
    const small = makeLegacyDb(".claude-observix", "content", fileName, "x".repeat(10));
    const big = makeLegacyDb(".claude-devcom", "content", fileName, "x".repeat(1000));
    makeLegacyDb(".claude-ime", "content", fileName, "x".repeat(200));

    const newDir = tempDir("ctx-global-content-");
    const newDbPath = join(newDir, fileName);

    const adopted = adoptLargestLegacyDb({ newDbPath, subdir: "content", fileName });

    expect(adopted).toBe(true);
    expect(existsSync(newDbPath)).toBe(true);
    expect(readFileSync(newDbPath, "utf-8")).toBe("x".repeat(1000));

    // Never deletes old files.
    expect(existsSync(small)).toBe(true);
    expect(existsSync(big)).toBe(true);
  });

  it("copies WAL/SHM sidecars alongside the adopted main file", () => {
    const fileName = "withwal.db";
    const main = makeLegacyDb(".claude-devcom", "content", fileName, "MAIN");
    writeFileSync(main + "-wal", "WAL-DATA");
    writeFileSync(main + "-shm", "SHM-DATA");

    const newDir = tempDir("ctx-global-wal-");
    const newDbPath = join(newDir, fileName);

    expect(adoptLargestLegacyDb({ newDbPath, subdir: "content", fileName })).toBe(true);
    expect(readFileSync(newDbPath + "-wal", "utf-8")).toBe("WAL-DATA");
    expect(readFileSync(newDbPath + "-shm", "utf-8")).toBe("SHM-DATA");
  });

  it("does nothing when the new location already has a DB (never overwrites)", () => {
    const fileName = "exists.db";
    makeLegacyDb(".claude-devcom", "content", fileName, "LEGACY-BIGGER-".repeat(50));

    const newDir = tempDir("ctx-global-exists-");
    const newDbPath = join(newDir, fileName);
    writeFileSync(newDbPath, "ALREADY-HERE");

    const adopted = adoptLargestLegacyDb({ newDbPath, subdir: "content", fileName });

    expect(adopted).toBe(false);
    expect(readFileSync(newDbPath, "utf-8")).toBe("ALREADY-HERE");
  });

  it("returns false when no legacy DB exists anywhere", () => {
    const newDir = tempDir("ctx-global-none-");
    const newDbPath = join(newDir, "nomatch.db");
    expect(adoptLargestLegacyDb({ newDbPath, subdir: "content", fileName: "nomatch.db" })).toBe(false);
    expect(existsSync(newDbPath)).toBe(false);
  });

  it("resolveContentStorePath adopts a legacy per-profile content DB on first resolve under the global root", () => {
    const projectDir = join(fakeHome, "adopt-me-project");
    const hash = hashProjectDirCanonical(projectDir);
    makeLegacyDb(".claude-devcom", "content", `${hash}.db`, "REAL-HISTORY-".repeat(20));

    const globalContentDir = tempDir("ctx-global-resolve-");
    const resolved = resolveContentStorePath({ projectDir, contentDir: globalContentDir });

    expect(existsSync(resolved)).toBe(true);
    expect(readFileSync(resolved, "utf-8")).toBe("REAL-HISTORY-".repeat(20));
  });

  it("is idempotent and safe when called twice for the same destination", () => {
    const fileName = "twice.db";
    makeLegacyDb(".claude-devcom", "content", fileName, "ONCE");

    const newDir = tempDir("ctx-global-twice-");
    const newDbPath = join(newDir, fileName);

    expect(adoptLargestLegacyDb({ newDbPath, subdir: "content", fileName })).toBe(true);
    // Second call: destination now exists, so it's a no-op (not a re-copy).
    expect(adoptLargestLegacyDb({ newDbPath, subdir: "content", fileName })).toBe(false);
    expect(readFileSync(newDbPath, "utf-8")).toBe("ONCE");
  });
});

// ─────────────────────────────────────────────────────────
// 4. Concurrency — N writers + readers, no lost writes, no SQLITE_BUSY throw
// ─────────────────────────────────────────────────────────

describe("concurrent access to a single global SessionDB", () => {
  it("N connections writing simultaneously lose no events and never throw", async () => {
    const dbPath = join(tempDir("ctx-concurrent-"), "shared.db");
    const WRITERS = 8;
    const EVENTS_PER_WRITER = 25;

    // Simulates N separate processes/sessions all pointed at the SAME
    // global DB file — the scenario a shared store makes routine.
    const connections = Array.from({ length: WRITERS }, () => new SessionDB({ dbPath }));

    try {
      const sessionId = `concurrent-${randomUUID()}`;
      connections[0].ensureSession(sessionId, "/concurrent/project");

      const errors: unknown[] = [];
      await Promise.all(
        connections.map((db, writerIdx) =>
          (async () => {
            for (let i = 0; i < EVENTS_PER_WRITER; i++) {
              // Yield to the event loop between writes so the writers'
              // transactions genuinely interleave rather than running as
              // one uninterrupted synchronous batch per connection.
              await new Promise((r) => setImmediate(r));
              try {
                db.insertEvent(sessionId, {
                  type: "file_read",
                  category: "file",
                  // Unique data per event — insertEvent dedups identical
                  // (type, data_hash) pairs within a short window, which
                  // would otherwise make this test undercount on purpose.
                  data: `writer-${writerIdx}-event-${i}-${randomUUID()}`,
                  priority: 1,
                }, "PostToolUse");
              } catch (err) {
                errors.push(err);
              }
            }
          })(),
        ),
      );

      expect(errors).toEqual([]); // no SQLITE_BUSY (or any other) throw

      // Read back through a fresh connection to the same file.
      const reader = new SessionDB({ dbPath });
      try {
        const events = reader.getEvents(sessionId, { limit: WRITERS * EVENTS_PER_WRITER + 10 });
        expect(events.length).toBe(WRITERS * EVENTS_PER_WRITER);
      } finally {
        reader.close();
      }
    } finally {
      for (const db of connections) db.close();
    }
  }, 30_000);
});
