/**
 * hooks/find-bun.mjs + hooks/hook-runtime.mjs
 *
 * Covers the opt-in, hook-spawn-scoped runtime resolver added alongside
 * tools/bench-hooks.mjs. Separate from tests/hook-runtime-resolution.test.ts,
 * which locks src/runtime.ts's resolveHookRuntime (no env var, by design -
 * see that file's header comment). This resolver is intentionally distinct:
 * bench-hooks.mjs measurements show Bun is slower than Node end-to-end for
 * every hook type on this repo (Windows), so the default here must NOT
 * unconditionally prefer Bun the way resolveHookRuntime does.
 */
import { describe, test, expect, afterEach } from "vitest";
import { findBun } from "../../hooks/find-bun.mjs";
import { resolveHookSpawnRuntime, resetHookSpawnRuntimeCache } from "../../hooks/hook-runtime.mjs";

describe("findBun", () => {
  test("prefers BUN_INSTALL/bin/bun when present", () => {
    const found = new Set(["/opt/custom-bun/bin/bun"]);
    const path = findBun({
      env: { BUN_INSTALL: "/opt/custom-bun", PATH: "" },
      platform: "linux",
      home: "/home/user",
      existsSync: (p) => found.has(p),
    });
    expect(path).toBe("/opt/custom-bun/bin/bun");
  });

  test("falls back to ~/.bun/bin/bun", () => {
    const found = new Set(["/home/user/.bun/bin/bun"]);
    const path = findBun({
      env: { PATH: "" },
      platform: "linux",
      home: "/home/user",
      existsSync: (p) => found.has(p),
    });
    expect(path).toBe("/home/user/.bun/bin/bun");
  });

  test("resolves via $PATH entries as a last resort", () => {
    const found = new Set(["/custom/path/dir/bun"]);
    const path = findBun({
      env: { PATH: "/custom/path/dir" },
      platform: "linux",
      home: "/nonexistent",
      existsSync: (p) => found.has(p),
    });
    expect(path).toBe("/custom/path/dir/bun");
  });

  test("uses win32 path joins (backslash, bun.exe) on Windows regardless of host", () => {
    const found = new Set(["C:\\Users\\me\\.bun\\bin\\bun.exe"]);
    const path = findBun({
      env: { PATH: "" },
      platform: "win32",
      home: "C:\\Users\\me",
      existsSync: (p) => found.has(p),
    });
    expect(path).toBe("C:\\Users\\me\\.bun\\bin\\bun.exe");
  });

  test("returns null when nothing matches", () => {
    const path = findBun({
      env: { PATH: "" },
      platform: "linux",
      home: "/nowhere",
      existsSync: () => false,
    });
    expect(path).toBeNull();
  });
});

describe("resolveHookSpawnRuntime", () => {
  afterEach(() => {
    resetHookSpawnRuntimeCache();
  });

  test('mode "node" always returns Node, even when Bun would resolve', () => {
    const r = resolveHookSpawnRuntime({
      env: { CONTEXT_MODE_HOOK_RUNTIME: "node" },
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(r).toEqual({ path: "/usr/bin/node", isBun: false });
  });

  test('mode "auto" on win32 defaults to Node (measured regression - see tools/bench-hooks.mjs)', () => {
    const r = resolveHookSpawnRuntime({
      env: { CONTEXT_MODE_HOOK_RUNTIME: "auto", PATH: "" },
      platform: "win32",
      execPath: "C:\\node.exe",
    });
    expect(r).toEqual({ path: "C:\\node.exe", isBun: false });
  });

  test("unset env var behaves like auto (defaults to Node on win32)", () => {
    const r = resolveHookSpawnRuntime({
      env: { PATH: "" },
      platform: "win32",
      execPath: "C:\\node.exe",
    });
    expect(r.isBun).toBe(false);
  });

  test('mode "bun" falls back to Node silently when no bun binary is found', () => {
    const r = resolveHookSpawnRuntime({
      env: { CONTEXT_MODE_HOOK_RUNTIME: "bun", PATH: "" },
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(r).toEqual({ path: "/usr/bin/node", isBun: false });
  });

  test("result is cached across calls until reset", () => {
    const r1 = resolveHookSpawnRuntime({ env: { CONTEXT_MODE_HOOK_RUNTIME: "node" }, execPath: "/a/node" });
    const r2 = resolveHookSpawnRuntime({ env: { CONTEXT_MODE_HOOK_RUNTIME: "bun" }, execPath: "/b/node" });
    expect(r2).toBe(r1); // same cached object, second call's args ignored
  });
});
