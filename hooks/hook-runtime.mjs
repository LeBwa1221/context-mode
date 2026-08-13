/**
 * Runtime selection for hook COMMAND SPAWNING (which binary hooks.json's
 * `node "<script>"` entries should actually invoke) - separate from
 * src/runtime.ts's `resolveHookRuntime`, which is locked to "no env var,
 * always prefer bun when found" per a 2026-05-31 design decision and is not
 * touched here (see tests/hook-runtime-resolution.test.ts for that lock).
 *
 * Why a second resolver exists: bench-hooks.mjs measurements on this repo
 * (Windows 11, Node 22.16 / Bun 1.3.14) show Bun is SLOWER end-to-end than
 * Node for every hook type tested (pretooluse, posttooluse, sessionstart,
 * userpromptsubmit, stop) - see tools/bench-hooks.mjs output. Unconditionally
 * preferring Bun (src/runtime.ts's current behaviour) would be a regression
 * on this platform, contradicting the premise #738 was filed under. Rather
 * than override that locked, cross-platform function without data from
 * macOS/Linux to back a change, this module adds an opt-in override scoped
 * to the hook-spawn decision only.
 *
 * Policy (CONTEXT_MODE_HOOK_RUNTIME env var, default "auto"):
 *   - "node"       always Node (process.execPath).
 *   - "bun"        Bun if found and passes a `--version` >=1.0 probe,
 *                  else silently falls back to Node.
 *   - "auto" (default)
 *       - win32:   Node (measured regression on this platform - see above).
 *       - other:   same as "bun" - unconditional-if-available, matching the
 *                  #738 assumption this repo already ships for non-hook-spawn
 *                  callers of resolveHookRuntime. No macOS/Linux hook-spawn
 *                  measurements exist yet to justify diverging there.
 *
 * Cached per-process. Never throws - any probe failure degrades to Node.
 */
import { execSync, execFileSync } from "node:child_process";
import { findBun } from "./find-bun.mjs";

let _cache = null;

function bunVersionAtLeast1(versionOutput) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(versionOutput).trim());
  return !!m && Number(m[1]) >= 1;
}

function probeBun(bunPath, platform) {
  try {
    const out = platform === "win32"
      ? execSync(`"${bunPath}" --version`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 })
      : execFileSync(bunPath, ["--version"], { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    return bunVersionAtLeast1(out);
  } catch {
    return false;
  }
}

/**
 * @param {{env?: object, platform?: string, execPath?: string}} [opts]
 * @returns {{path: string, isBun: boolean}}
 */
export function resolveHookSpawnRuntime({
  env = process.env,
  platform = process.platform,
  execPath = process.execPath,
} = {}) {
  if (_cache) return _cache;

  const nodeResult = { path: execPath, isBun: false };
  const mode = (env.CONTEXT_MODE_HOOK_RUNTIME || "auto").toLowerCase();

  if (mode === "node") {
    _cache = nodeResult;
    return _cache;
  }

  const wantsBun = mode === "bun" || (mode === "auto" && platform !== "win32");
  if (!wantsBun) {
    _cache = nodeResult;
    return _cache;
  }

  try {
    const bunPath = findBun({ env, platform });
    if (bunPath && probeBun(bunPath, platform)) {
      _cache = { path: bunPath, isBun: true };
      return _cache;
    }
  } catch {
    /* fall through to node */
  }
  _cache = nodeResult;
  return _cache;
}

/** Test-only: clear the per-process cache. */
export function resetHookSpawnRuntimeCache() {
  _cache = null;
}
