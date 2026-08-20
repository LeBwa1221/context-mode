/**
 * Shared context-mode data-root resolution.
 *
 * Extracted from src/adapters/base.ts so src/session/db.ts can resolve the
 * SAME global root without creating a circular import: base.ts already
 * imports hashProjectDirCanonical from session/db.ts, so db.ts importing
 * resolveContextModeDataRoot back from base.ts would cycle. This module has
 * no dependency on session/db.ts. src/adapters/base.ts re-exports these so
 * its existing importers (adapters, analytics.ts) are unaffected.
 */

import { join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * OS-appropriate shared app-data directory used as the default context-mode
 * data root when no override env var is set. Deliberately NOT derived from
 * any host's config dir (`~/.claude`, `~/.codex`, ...) — that is exactly the
 * per-profile coupling this default replaces. Built from `homedir()` rather
 * than reading `LOCALAPPDATA`/etc directly so the whole resolver stays
 * mockable through the single `homedir()` seam tests already use (see
 * tests/setup-home.ts) — matches the platform convention either way.
 *
 * Callers append `context-mode/<sessions|memory|...>` themselves (same
 * contract as before), so this returns the PARENT of that folder, not the
 * folder itself — e.g. `%LOCALAPPDATA%`, not `%LOCALAPPDATA%\context-mode`.
 *
 * `homeOverride` lets callers (analytics.ts's `enumerateAdapterDirs`) supply
 * an explicit home directory instead of relying on the ambient `homedir()`
 * mock seam — see PR #866: a resolver that reads ambient state from deep in
 * the call graph instead of a parameter makes it easy for ONE branch to
 * silently ignore a caller-supplied override while others honor it.
 */
function defaultGlobalDataRoot(env: NodeJS.ProcessEnv, homeOverride?: string): string {
  const home = homeOverride ?? homedir();
  if (process.platform === "win32") {
    return join(home, "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg ? resolve(xdg) : join(home, ".local", "share");
}

/**
 * Universal storage-root resolution. Priority:
 *   1. `CONTEXT_MODE_HOME` (current name)
 *   2. `CONTEXT_MODE_DATA_DIR` (#649 back-compat alias)
 *   3. the OS-appropriate global data dir (see `defaultGlobalDataRoot`)
 *
 * Always returns an absolute path — never null. Callers append
 * `context-mode/<sessions|memory|...>` themselves, same contract as #649.
 *
 * Mirrors the `resolveClaudeConfigDir` contract for env-var handling
 * (whitespace guard, tilde expansion, relative-path resolution) so users
 * get one consistent set of rules across every override site.
 *
 * `homeOverride` — see `defaultGlobalDataRoot`'s doc comment. Only affects
 * the OS-default branch; an explicit `CONTEXT_MODE_HOME`/`CONTEXT_MODE_DATA_DIR`
 * always wins regardless of `homeOverride`, same as it wins regardless of
 * ambient `homedir()`.
 */
export function resolveContextModeDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeOverride?: string,
): string {
  return resolveContextModeDataRootOverride(env) ?? defaultGlobalDataRoot(env, homeOverride);
}

/**
 * The override-only half of {@link resolveContextModeDataRoot}: returns the
 * resolved path when `CONTEXT_MODE_HOME`/`CONTEXT_MODE_DATA_DIR` is set to a
 * non-blank value, otherwise `null`. Kept separate so callers that want
 * "explicit override, else MY OWN per-adapter default" (e.g. `getMemoryDir`,
 * which is project-scoped via `getConfigDir()` for several adapters and was
 * never part of the profile-forking bug `resolveContextModeDataRoot` fixes)
 * can distinguish "no override" from "the default happens to be this path".
 */
export function resolveContextModeDataRootOverride(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.CONTEXT_MODE_HOME ?? env.CONTEXT_MODE_DATA_DIR;
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("~")) {
    return resolve(homedir(), trimmed.replace(/^~[/\\]?/, ""));
  }
  return resolve(trimmed);
}
