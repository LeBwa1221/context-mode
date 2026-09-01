/**
 * multi-adapter-stats — B3a (PRD-stats-multi-adapter)
 *
 * Today `getLifetimeStats` and `getRealBytesStats` scan ONE sessionsDir
 * (~/.claude/context-mode/sessions/ by default). The marketing line
 * promises "your work everywhere on this machine across all AI tools" —
 * code MUST aggregate across every adapter dir.
 *
 * This file tests the additive multi-adapter API. Existing single-dir
 * behaviour is covered by `lifetime-stats.test.ts` and
 * `real-bytes-stats.test.ts` and must keep passing untouched.
 *
 * Cited code:
 *   src/session/analytics.ts:592-731  — current getLifetimeStats (single-dir)
 *   src/session/analytics.ts:887-989  — current getRealBytesStats (single-dir)
 *   src/adapters/detect.ts:92-111     — getSessionDirSegments map (17 platforms)
 *
 * Filter (decided in /diagnose conversation, B3a PRD):
 *   real = eventCount >= 100
 *       && distinctProjects >= 5
 *       && lastActivityWithin(30 days)
 *       && avgEventBytes >= 50
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, test } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { resolveContextModeDataRoot } from "../../src/adapters/base.js";
import {
  enumerateAdapterDirs,
  getMultiAdapterLifetimeStats,
  getMultiAdapterRealBytesStats,
  getLifetimeStats,
} from "../../src/session/analytics.js";

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try { fn(); } catch { /* ignore */ }
  }
});

function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "multi-adapter-home-"));
  cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}

function dbPathFor(sessionsDir: string, hash: string): string {
  return join(sessionsDir, `${hash}__suffix.db`);
}

function seed(
  dbPath: string,
  sessionId: string,
  events: Array<{ type: string; category: string; data: string; bytesAvoided?: number; bytesReturned?: number; projectDir?: string }>,
  snapshots?: Array<{ snapshot: string }>,
): void {
  const sdb = new SessionDB({ dbPath });
  try {
    sdb.ensureSession(sessionId, events[0]?.projectDir ?? "/tmp/proj");
    let i = 0;
    for (const e of events) {
      sdb.insertEvent(
        sessionId,
        {
          type: e.type,
          category: e.category,
          priority: 1,
          data: `${e.data}#${i++}`,
          project_dir: e.projectDir ?? "",
          attribution_source: "test",
          attribution_confidence: 1,
        },
        "test",
        undefined,
        { bytesAvoided: e.bytesAvoided, bytesReturned: e.bytesReturned },
      );
    }
    if (snapshots) {
      for (const s of snapshots) sdb.upsertResume(sessionId, s.snapshot, events.length);
    }
  } finally {
    sdb.close();
  }
}

// ─────────────────────────────────────────────────────────
// Slice 2.1 — adapter dir enumeration
// ─────────────────────────────────────────────────────────

describe("Slice 2.1 — enumerateAdapterDirs()", () => {
  // maint/global-store: 17 legacy per-profile entries collapse where they
  // resolve to the identical path (gemini-cli/antigravity/antigravity-cli
  // all shared ~/.gemini/context-mode even before the global-store change —
  // a pre-existing bug this dedup also fixes), plus ONE new "context-mode"
  // entry for the current global root. 17 - 2 merged + 1 new = 16.
  test("returns one entry per DISTINCT resolved path (legacy dedup + one new global-root entry)", () => {
    const dirs = enumerateAdapterDirs({ home: "/HOME" });
    const names = dirs.map((d) => d.name).sort();
    expect(names).toEqual(
      [
        "claude-code",
        "codex",
        "context-mode",
        "copilot-cli",
        "cursor",
        "gemini-cli",
        "jetbrains-copilot",
        "kilo",
        "kiro",
        "omp",
        "opencode",
        "openclaw",
        "pi",
        "qwen-code",
        "vscode-copilot",
        "zed",
      ].sort(),
    );
    expect(dirs.length).toBe(16);
  });

  test("gemini-cli, antigravity, and antigravity-cli merge into ONE entry (they share ~/.gemini/context-mode)", () => {
    const dirs = enumerateAdapterDirs({ home: "/HOME" });
    const gemini = dirs.find((d) => d.sessionsDir === join("/HOME", ".gemini", "context-mode", "sessions"));
    expect(gemini).toBeDefined();
    expect(gemini!.names.sort()).toEqual(["antigravity", "antigravity-cli", "gemini-cli"]);
  });

  test("the new global-root entry is distinct from every legacy entry and reflects resolveContextModeDataRoot", () => {
    const home = "/HOME";
    const dirs = enumerateAdapterDirs({ home });
    const globalEntry = dirs.find((d) => d.name === "context-mode")!;
    expect(globalEntry).toBeDefined();
    expect(globalEntry.sessionsDir).toBe(
      join(resolveContextModeDataRoot(process.env, home), "context-mode", "sessions"),
    );
    // No legacy per-profile entry happens to collide with it.
    const legacyPaths = dirs.filter((d) => d.name !== "context-mode").map((d) => d.sessionsDir);
    expect(legacyPaths).not.toContain(globalEntry.sessionsDir);
  });

  test("each entry exposes sessionsDir and contentDir under <home>/<segments>/context-mode/", () => {
    const home = "/HOME";
    // Pin claudeConfigDir so the claude-code entry stays under <home>/.claude
    // regardless of the runner's $CLAUDE_CONFIG_DIR (#865).
    const dirs = enumerateAdapterDirs({ home, claudeConfigDir: join(home, ".claude") });
    // Use path.join() so the expected prefix/suffix match the platform's
    // separator. enumerateAdapterDirs uses node:path.join under the hood,
    // which emits backslashes on Windows AND converts the leading "/" of
    // "/HOME" to "\\". Normalize the home prefix through join() too — a
    // raw "/HOME" + sep would compare against an apple-and-orange first
    // character on Windows ("/HOME\\..." vs actual "\\HOME\\...").
    const expectedHomePrefix = join(home) + sep;
    const expectedSessionsSuffix = sep + join("context-mode", "sessions");
    const expectedContentSuffix = sep + join("context-mode", "content");
    for (const d of dirs) {
      expect(d.sessionsDir.startsWith(expectedHomePrefix)).toBe(true);
      expect(d.contentDir.startsWith(expectedHomePrefix)).toBe(true);
      expect(d.sessionsDir.endsWith(expectedSessionsSuffix)).toBe(true);
      expect(d.contentDir.endsWith(expectedContentSuffix)).toBe(true);
    }
  });

  test("uses the same segment map as src/adapters/detect.ts:92-111 (claude-code under .claude, kilo under .config/kilo, pi under .pi)", () => {
    const home = "/HOME";
    // Pin claudeConfigDir so claude-code asserts deterministically under
    // <home>/.claude regardless of the runner's $CLAUDE_CONFIG_DIR (#865).
    const dirs = enumerateAdapterDirs({ home, claudeConfigDir: join(home, ".claude") });
    const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));
    // Build expectations through path.join so backslashes on Windows match.
    expect(byName["claude-code"].sessionsDir).toBe(join(home, ".claude", "context-mode", "sessions"));
    expect(byName["kilo"].sessionsDir).toBe(join(home, ".config", "kilo", "context-mode", "sessions"));
    expect(byName["pi"].sessionsDir).toBe(join(home, ".pi", "context-mode", "sessions"));
    // antigravity merged into the gemini-cli entry (they share ~/.gemini/context-mode) —
    // look it up by `names` instead of a dedicated top-level key.
    const antigravity = dirs.find((d) => d.names.includes("antigravity"))!;
    expect(antigravity.sessionsDir).toBe(join(home, ".gemini", "context-mode", "sessions"));
    expect(byName["jetbrains-copilot"].sessionsDir).toBe(join(home, ".config", "JetBrains", "context-mode", "sessions"));
  });

  test("defaults to os.homedir() when no override passed", () => {
    const dirs = enumerateAdapterDirs();
    // On win32 with a real %APPDATA%, two more entries (kilo, opencode)
    // come from LEGACY_ADAPTER_APPDATA_SEGMENTS - see enumerateAdapterDirs'
    // doc comment. Only fires with no explicit `home` override, same as
    // real (non-test) usage.
    const expectedCount = process.platform === "win32" && process.env.APPDATA ? 18 : 16;
    expect(dirs.length).toBe(expectedCount);
    const expectedSuffix = sep + join("context-mode", "sessions");
    expect(dirs.every((d) => d.sessionsDir.includes(expectedSuffix))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.1b — enumerateAdapterDirs honors $CLAUDE_CONFIG_DIR (#865)
// ─────────────────────────────────────────────────────────

// Contract: $CLAUDE_CONFIG_DIR is consulted only when the caller does not
// override `home` — a supplied `home` fully determines the result (#866
// purity fix). Real callers (src/server.ts, bin/statusline.mjs) always omit
// `home`, so the env var keeps working exactly as #865 intended.
describe("Slice 2.1b — enumerateAdapterDirs CLAUDE_CONFIG_DIR (#865)", () => {
  test("claude-code entry honors claudeConfigDir override; other adapters stay under home", () => {
    const home = "/HOME";
    const customCfg = "/custom/claude-cfg";
    const dirs = enumerateAdapterDirs({ home, claudeConfigDir: customCfg });
    const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));
    expect(byName["claude-code"].sessionsDir).toBe(
      join(customCfg, "context-mode", "sessions"),
    );
    expect(byName["codex"].sessionsDir).toBe(
      join(home, ".codex", "context-mode", "sessions"),
    );
  });

  test("claude-code falls back to <home>/.claude when no override and no home given (env unset → ~/.claude)", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const dirs = enumerateAdapterDirs();
      const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));
      expect(byName["claude-code"].sessionsDir).toBe(
        join(resolve(homedir(), ".claude"), "context-mode", "sessions"),
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  test("claude-code reflects $CLAUDE_CONFIG_DIR at runtime when home is omitted (no opt override)", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude-cfg";
    try {
      const dirs = enumerateAdapterDirs();
      const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));
      // resolveClaudeConfigDir() applies resolve() to $CLAUDE_CONFIG_DIR, which on
      // Windows prepends the current drive (e.g. D:\tmp\...). Mirror that here so the
      // expectation matches on every platform (no-op on POSIX). (#866 Windows CI)
      expect(byName["claude-code"].sessionsDir).toBe(
        join(resolve("/tmp/custom-claude-cfg"), "context-mode", "sessions"),
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });

  // A caller-supplied `home` makes enumerateAdapterDirs pure: it must fully
  // determine the result, not be silently overridden by the ambient
  // $CLAUDE_CONFIG_DIR env var. Real callers that want the env var honored
  // omit `home` (see the two tests above) or pass an explicit claudeConfigDir.
  // Regression guard for the bug this replaced: a caller-supplied home that
  // does NOT determine the result is exactly what let claude-code's content
  // DB drop out of multi-adapter aggregation (real-bytes-stats.test.ts).
  test("claude-code stays under <home>/.claude when home is given, even if $CLAUDE_CONFIG_DIR is set (purity)", () => {
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/tmp/custom-claude-cfg";
    try {
      const dirs = enumerateAdapterDirs({ home: "/HOME" });
      const byName = Object.fromEntries(dirs.map((d) => [d.name, d]));
      expect(byName["claude-code"].sessionsDir).toBe(
        join("/HOME", ".claude", "context-mode", "sessions"),
      );
      expect(byName["codex"].sessionsDir).toBe(
        join("/HOME", ".codex", "context-mode", "sessions"),
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    }
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.2 — multi-adapter scan with per-source breakdown
// ─────────────────────────────────────────────────────────

describe("Slice 2.2 — getMultiAdapterLifetimeStats()", () => {
  test("aggregates totals across two adapter dirs and returns per-adapter breakdown", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    seed(dbPathFor(claudeSessions, "aaaaaaaaaaaaaaaa"), `cc-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "src/a.ts", projectDir: "/p/cc" },
      { type: "tool_use", category: "file", data: "src/b.ts", projectDir: "/p/cc" },
    ]);
    seed(dbPathFor(codexSessions, "bbbbbbbbbbbbbbbb"), `cdx-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "src/c.ts", projectDir: "/p/cdx" },
    ]);

    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });

    expect(r.totalEvents).toBe(3);
    expect(r.totalSessions).toBe(2);
    expect(typeof r.totalBytes).toBe("number");
    expect(r.totalBytes).toBeGreaterThan(0);

    expect(Array.isArray(r.perAdapter)).toBe(true);
    const byName = Object.fromEntries(r.perAdapter.map((a) => [a.name, a]));
    expect(byName["claude-code"]).toBeDefined();
    expect(byName["claude-code"].eventCount).toBe(2);
    expect(byName["claude-code"].projectDirs).toContain("/p/cc");
    expect(byName["codex"]).toBeDefined();
    expect(byName["codex"].eventCount).toBe(1);
    expect(byName["codex"].projectDirs).toContain("/p/cdx");
  });

  test("each perAdapter entry exposes eventCount, dataBytes, rescueBytes, contentBytes, uuidConvs, projectDirs, firstMs, isReal", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    seed(dbPathFor(claudeSessions, "1111111111111111"), `s-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "x", projectDir: "/p/x" },
    ], [{ snapshot: "Z".repeat(2_000) }]);

    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc).toBeDefined();
    expect(typeof cc.eventCount).toBe("number");
    expect(typeof cc.dataBytes).toBe("number");
    expect(typeof cc.rescueBytes).toBe("number");
    expect(typeof cc.contentBytes).toBe("number");
    expect(typeof cc.uuidConvs).toBe("number");
    expect(Array.isArray(cc.projectDirs)).toBe(true);
    expect(typeof cc.firstMs).toBe("number");
    expect(typeof cc.isReal).toBe("boolean");
  });

  test("skips adapter dirs that don't exist on disk (no throw, just absent from perAdapter)", () => {
    const home = tmpHome(); // empty home — no adapter dirs created
    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });
    expect(r.totalEvents).toBe(0);
    expect(r.totalSessions).toBe(0);
    expect(r.perAdapter).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// maint/global-store — dedup regression guards
//
// The two bugs measured on real disk before this fix:
//   1. gemini-cli/antigravity/antigravity-cli shared ~/.gemini/context-mode
//      and were triple-counted in totalEvents (pre-existing, independent of
//      the global-root change).
//   2. After the global-root change, adapters' REAL getSessionDir() drifted
//      from enumerateAdapterDirs' hardcoded legacy map, so ctx_stats went
//      blind on all new data.
// ─────────────────────────────────────────────────────────

describe("maint/global-store — no double-count when adapters share a dir", () => {
  test("events in a directory shared by 3 legacy adapter names are counted ONCE, not 3x", () => {
    const home = tmpHome();
    // gemini-cli, antigravity, and antigravity-cli all resolve to this one
    // physical directory (see enumerateAdapterDirs' dedup note).
    const sharedSessions = ensureDir(join(home, ".gemini", "context-mode", "sessions"));
    seed(dbPathFor(sharedSessions, "cccccccccccccccc"), `shared-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "src/a.ts", projectDir: "/p/shared" },
      { type: "tool_use", category: "file", data: "src/b.ts", projectDir: "/p/shared" },
    ]);

    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });

    // Exactly one perAdapter row for the shared directory, not three.
    const rows = r.perAdapter.filter((a) => a.names.includes("antigravity"));
    expect(rows.length).toBe(1);
    expect(rows[0].names.sort()).toEqual(["antigravity", "antigravity-cli", "gemini-cli"]);
    expect(rows[0].eventCount).toBe(2); // NOT 6 (2 events x 3 adapter names)
    expect(r.totalEvents).toBe(2);
  });

  test("getMultiAdapterRealBytesStats also counts a shared directory's bytes once", () => {
    const home = tmpHome();
    const sharedSessions = ensureDir(join(home, ".gemini", "context-mode", "sessions"));
    seed(dbPathFor(sharedSessions, "dddddddddddddddd"), `shared-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "p", bytesAvoided: 5_000 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home, claudeConfigDir: join(home, ".claude") });

    expect(r.bytesAvoided).toBe(5_000); // NOT 15_000 (3x)
    const rows = r.perAdapter.filter((a) => a.names.includes("antigravity"));
    expect(rows.length).toBe(1);
  });
});

// maint/global-store — project-level dedup between a legacy adapter dir and
// the new global root. adoptLargestLegacyDb() COPIES a project's DB forward
// (never deletes the original), so the SAME <hash>.db filename can exist in
// both places for a migrated project. Counting both would double a migrated
// project's history, so exactly one copy must be counted — but which copy
// is authoritative is NOT assumed from location (that assumption was
// measured false; see the phase 3 test below). It's decided by comparing
// actual row counts.
describe("maint/global-store — project-level dedup (legacy vs global root copy)", () => {
  function globalSessionsDirFor(home: string): string {
    return join(resolveContextModeDataRoot(process.env, home), "context-mode", "sessions");
  }

  test("a project migrated to the global root is counted ONCE, using the global copy", () => {
    const home = tmpHome();
    const legacySessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const globalSessions = ensureDir(globalSessionsDirFor(home));
    const hash = "eeeeeeeeeeeeeeee";

    // Legacy copy: 2 events, frozen since migration (adoptLargestLegacyDb
    // never writes to it again).
    seed(dbPathFor(legacySessions, hash), `legacy-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "old-a", projectDir: "/p/migrated" },
      { type: "tool_use", category: "file", data: "old-b", projectDir: "/p/migrated" },
    ]);
    // Global copy: adopted the same 2 events PLUS 1 new one written after
    // migration — the superset.
    seed(dbPathFor(globalSessions, hash), `global-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "old-a", projectDir: "/p/migrated" },
      { type: "tool_use", category: "file", data: "old-b", projectDir: "/p/migrated" },
      { type: "tool_use", category: "file", data: "new-c", projectDir: "/p/migrated" },
    ]);

    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });

    // Only the global copy's 3 events count, not 3 + 2 = 5.
    expect(r.totalEvents).toBe(3);
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc.eventCount).toBe(0); // legacy claude-code entry contributed nothing — its only file was excluded
    const global = r.perAdapter.find((a) => a.name === "context-mode")!;
    expect(global.eventCount).toBe(3);
  });

  test("an un-migrated project (legacy-only, no global copy) is still counted normally", () => {
    const home = tmpHome();
    const legacySessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    seed(dbPathFor(legacySessions, "ffffffffffffffff"), `unmigrated-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "x", projectDir: "/p/unmigrated" },
    ]);
    // No global-root dir created at all — nothing has been migrated yet.

    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });

    expect(r.totalEvents).toBe(1); // not blind to it
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc).toBeDefined();
    expect(cc.eventCount).toBe(1);
  });

  test("counts the legacy copy, not the global one, when the global copy is NOT a superset (phase 3 false-invariant fix)", () => {
    // Measured false in the wild (docs/plan-store-unification.md phase 3):
    // a legacy profile store can have MORE events than the global root, e.g.
    // when adoption copied forward a smaller profile's file, or a legacy
    // client kept writing after migration. Blindly trusting the global copy
    // would under-count this project's history; blindly summing both would
    // double-count the events the two copies share. Counting by actual row
    // count picks the copy with more events (legacy, here) and excludes the
    // other, giving neither an under-count nor a double-count.
    const home = tmpHome();
    const legacySessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const globalSessions = ensureDir(globalSessionsDirFor(home));
    const hash = "abcdefabcdefabcd";

    seed(dbPathFor(globalSessions, hash), `global-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "g-a", projectDir: "/p/diverged" },
    ]);
    seed(dbPathFor(legacySessions, hash), `legacy-${randomUUID()}`, [
      { type: "tool_use", category: "file", data: "l-a", projectDir: "/p/diverged" },
      { type: "tool_use", category: "file", data: "l-b", projectDir: "/p/diverged" },
      { type: "tool_use", category: "file", data: "l-c", projectDir: "/p/diverged" },
    ]);

    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });

    expect(r.totalEvents).toBe(3); // the larger (legacy) copy, counted once

    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    const global = r.perAdapter.find((a) => a.name === "context-mode")!;
    expect(cc.eventCount).toBe(3);
    expect(global.eventCount).toBe(0);
  });

  test("getMultiAdapterRealBytesStats also prefers the global copy for a migrated project", () => {
    const home = tmpHome();
    const legacySessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const globalSessions = ensureDir(globalSessionsDirFor(home));
    const hash = "1234567812345678";

    seed(dbPathFor(legacySessions, hash), `legacy-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "p", bytesAvoided: 2_000 },
    ]);
    seed(dbPathFor(globalSessions, hash), `global-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "p", bytesAvoided: 2_000 },
      { type: "x", category: "sandbox", data: "q", bytesAvoided: 9_000 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home, claudeConfigDir: join(home, ".claude") });

    expect(r.bytesAvoided).toBe(11_000); // the global copy's total, not 11_000 + 2_000
  });
});

describe("maint/global-store — enumeration matches real adapter defaults (drift guard)", () => {
  test("the context-mode entry matches ClaudeCodeAdapter's real getSessionDir() (no explicit override set)", async () => {
    const { ClaudeCodeAdapter } = await import("../../src/adapters/claude-code/index.js");
    const savedHome = process.env.CONTEXT_MODE_HOME;
    const savedDataDir = process.env.CONTEXT_MODE_DATA_DIR;
    delete process.env.CONTEXT_MODE_HOME;
    delete process.env.CONTEXT_MODE_DATA_DIR;
    try {
      const adapter = new ClaudeCodeAdapter();
      const real = adapter.getSessionDir();
      const dirs = enumerateAdapterDirs(); // home omitted — same ambient homedir() as the real adapter
      const globalEntry = dirs.find((d) => d.name === "context-mode")!;
      expect(globalEntry.sessionsDir).toBe(real);
    } finally {
      if (savedHome === undefined) delete process.env.CONTEXT_MODE_HOME; else process.env.CONTEXT_MODE_HOME = savedHome;
      if (savedDataDir === undefined) delete process.env.CONTEXT_MODE_DATA_DIR; else process.env.CONTEXT_MODE_DATA_DIR = savedDataDir;
    }
  });

  test("the context-mode entry moves with CONTEXT_MODE_HOME, tracking every default-inheriting adapter", async () => {
    const { CursorAdapter } = await import("../../src/adapters/cursor/index.js");
    const custom = tmpHome();
    const saved = process.env.CONTEXT_MODE_HOME;
    process.env.CONTEXT_MODE_HOME = custom;
    try {
      const adapter = new CursorAdapter();
      const real = adapter.getSessionDir();
      const dirs = enumerateAdapterDirs();
      const globalEntry = dirs.find((d) => d.name === "context-mode")!;
      expect(globalEntry.sessionsDir).toBe(real);
      expect(globalEntry.sessionsDir).toBe(join(custom, "context-mode", "sessions"));
    } finally {
      if (saved === undefined) delete process.env.CONTEXT_MODE_HOME; else process.env.CONTEXT_MODE_HOME = saved;
    }
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.3 — real-usage filter
// ─────────────────────────────────────────────────────────

describe("Slice 2.3 — isReal filter (eventCount>=100 && distinctProjects>=5 && within 30 days && avgBytes>=50)", () => {
  test("flags adapter with only test fixtures (low event count, low projects) as isReal=false", () => {
    const home = tmpHome();
    const sessionsDir = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    // 5 events, 1 project — fails both eventCount>=100 and distinctProjects>=5
    seed(dbPathFor(sessionsDir, "fixtxtxfixtxfixt"), `fx-${randomUUID()}`, [
      { type: "t", category: "file", data: "a", projectDir: "/p" },
      { type: "t", category: "file", data: "b", projectDir: "/p" },
      { type: "t", category: "file", data: "c", projectDir: "/p" },
      { type: "t", category: "file", data: "d", projectDir: "/p" },
      { type: "t", category: "file", data: "e", projectDir: "/p" },
    ]);
    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc.isReal).toBe(false);
  });

  test("flags adapter with avgBytes<50 as isReal=false even with many events and projects", () => {
    const home = tmpHome();
    const sessionsDir = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    // 120 tiny events across 6 projects — passes count + projects + recency,
    // but each row data is "x#N" so average bytes < 50.
    const events = [];
    for (let i = 0; i < 120; i++) {
      events.push({ type: "t", category: "file", data: "x", projectDir: `/p/${i % 6}` });
    }
    seed(dbPathFor(sessionsDir, "tinyrowstinyrows"), `tiny-${randomUUID()}`, events);
    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc.eventCount).toBeGreaterThanOrEqual(100);
    expect(cc.isReal).toBe(false); // avgBytes too low
  });

  test("flags adapter passing all four thresholds as isReal=true", () => {
    const home = tmpHome();
    const sessionsDir = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    // 120 fat events across 6 projects, all very recent. data is 200 bytes each.
    const fat = "y".repeat(200);
    const events = [];
    for (let i = 0; i < 120; i++) {
      events.push({ type: "t", category: "file", data: fat, projectDir: `/p/${i % 6}` });
    }
    seed(dbPathFor(sessionsDir, "realdatasrealdat"), `real-${randomUUID()}`, events);
    const r = getMultiAdapterLifetimeStats({ home, claudeConfigDir: join(home, ".claude") });
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    expect(cc.eventCount).toBeGreaterThanOrEqual(100);
    expect(cc.projectDirs.length).toBeGreaterThanOrEqual(5);
    expect(cc.isReal).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.4 — real-bytes multi-adapter variant
// ─────────────────────────────────────────────────────────

describe("Slice 2.4 — getMultiAdapterRealBytesStats()", () => {
  test("aggregates real bytes from all adapter dirs (lifetime tier)", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    seed(dbPathFor(claudeSessions, "1111111111111111"), `a-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "p", bytesAvoided: 2_000, bytesReturned: 1_000 },
    ]);
    seed(dbPathFor(codexSessions, "2222222222222222"), `b-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "q", bytesAvoided: 3_000 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home, claudeConfigDir: join(home, ".claude") });
    expect(r.bytesAvoided).toBe(5_000);
    expect(r.bytesReturned).toBe(1_000);
    expect(r.totalSavedTokens).toBeGreaterThan(0);
    // perAdapter shows split
    expect(r.perAdapter.length).toBeGreaterThanOrEqual(2);
    const cc = r.perAdapter.find((a) => a.name === "claude-code")!;
    const cdx = r.perAdapter.find((a) => a.name === "codex")!;
    expect(cc.bytesAvoided).toBe(2_000);
    expect(cdx.bytesAvoided).toBe(3_000);
  });

  test("sessionId filter narrows to one session across all adapter dirs", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    const target = `target-${randomUUID()}`;
    seed(dbPathFor(claudeSessions, "1111111111111111"), target, [
      { type: "x", category: "sandbox", data: "p", bytesAvoided: 7_000 },
    ]);
    seed(dbPathFor(codexSessions, "2222222222222222"), `other-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "q", bytesAvoided: 9_999 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home, claudeConfigDir: join(home, ".claude"), sessionId: target });
    expect(r.bytesAvoided).toBe(7_000); // ONLY the matching session_id
  });

  test("worktreeHash filter applies to filename prefix in every adapter dir", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));

    seed(dbPathFor(claudeSessions, "60303a5b5b31fb98"), `a-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "p", bytesReturned: 7_000 },
    ]);
    seed(dbPathFor(codexSessions, "60303a5b5b31fb98"), `b-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "q", bytesReturned: 4_000 },
    ]);
    seed(dbPathFor(claudeSessions, "ffffffffffffffff"), `c-${randomUUID()}`, [
      { type: "x", category: "sandbox", data: "r", bytesReturned: 99_999 },
    ]);

    const r = getMultiAdapterRealBytesStats({ home, claudeConfigDir: join(home, ".claude"), worktreeHash: "60303a5b5b31fb98" });
    expect(r.bytesReturned).toBe(11_000); // 7_000 + 4_000, NOT 99_999
  });

  test("returns zeroes when no adapter dir exists", () => {
    const home = tmpHome();
    const r = getMultiAdapterRealBytesStats({ home, claudeConfigDir: join(home, ".claude") });
    expect(r.eventDataBytes).toBe(0);
    expect(r.bytesAvoided).toBe(0);
    expect(r.bytesReturned).toBe(0);
    expect(r.snapshotBytes).toBe(0);
    expect(r.totalSavedTokens).toBe(0);
    expect(r.perAdapter).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────
// Slice 2.5 — backward compat (sanity guard inside this file too)
// ─────────────────────────────────────────────────────────

describe("Slice 2.5 — backward compat", () => {
  test("getLifetimeStats and getRealBytesStats are still exported and accept sessionsDir", async () => {
    const m = await import("../../src/session/analytics.js");
    expect(typeof m.getLifetimeStats).toBe("function");
    expect(typeof m.getRealBytesStats).toBe("function");
    expect(typeof m.enumerateAdapterDirs).toBe("function");
    expect(typeof m.getMultiAdapterLifetimeStats).toBe("function");
    expect(typeof m.getMultiAdapterRealBytesStats).toBe("function");
  });

  test("multi-adapter helpers do NOT mutate single-dir behaviour: getLifetimeStats({sessionsDir}) only sees that one dir", () => {
    const home = tmpHome();
    const claudeSessions = ensureDir(join(home, ".claude", "context-mode", "sessions"));
    const codexSessions = ensureDir(join(home, ".codex", "context-mode", "sessions"));
    seed(dbPathFor(claudeSessions, "1111111111111111"), `a-${randomUUID()}`, [
      { type: "t", category: "file", data: "x", projectDir: "/p/cc" },
    ]);
    seed(dbPathFor(codexSessions, "2222222222222222"), `b-${randomUUID()}`, [
      { type: "t", category: "file", data: "y", projectDir: "/p/cdx" },
    ]);

    const memoryRoot = ensureDir(join(home, "memory"));
    const single = getLifetimeStats({ sessionsDir: claudeSessions, memoryRoot });
    expect(single.totalEvents).toBe(1); // ONLY claude — not 2
  });
});
