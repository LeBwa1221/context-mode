/**
 * BaseAdapter — shared implementation for methods identical across all adapters.
 *
 * Each concrete adapter extends this and provides platform-specific logic.
 *
 * Shared methods:
 *   - getSessionDir()       — builds session dir from sessionDirSegments
 *   - backupSettings()      — copies settings file to .bak
 *
 * Adapters with custom logic override the relevant method:
 *   - vscode-copilot: overrides getSessionDir (checks .github dir)
 *   - opencode: overrides getSessionDir (XDG_CONFIG_HOME / APPDATA)
 *              and backupSettings (calls checkPluginRegistration first)
 *   - openclaw: overrides backupSettings (searches 3 config paths)
 *
 * NOTE — C2 narrowing (2026-05): `getSessionDBPath` and `getSessionEventsPath`
 * were removed. Both were SHALLOW pure derivatives of `getSessionDir() +
 * projectDir` (interface complexity == implementation complexity). All
 * adapter-storage path computation now flows through ONE site:
 * `resolveSessionDbPath({ projectDir, sessionsDir: adapter.getSessionDir() })`
 * in `src/session/db.ts`. Adapters expose only `getSessionDir()` for
 * storage-related path concerns.
 *
 * Issue #649 — `CONTEXT_MODE_DATA_DIR` universal storage override. Many
 * adapters (Pi, OMP, Gemini CLI, Codex, Cursor, …) had storage hardcoded to
 * `~/.<platform>/context-mode/sessions/` with no env-var escape hatch. CI
 * runners on NFS homes, dev containers, and shared-workspace setups need to
 * point context-mode storage at a writable volume without patching source or
 * abusing the host platform's own config-dir variable. The override applies
 * only to context-mode-owned state (`getSessionDir`, `getMemoryDir`) — never
 * to platform-native config (`getConfigDir`, `getSettingsPath`), which must
 * stay where the host platform's own tooling expects it. Adapters that
 * override `getSessionDir`/`getMemoryDir` directly (claude-code, codex,
 * opencode, vscode-copilot) honor the override by routing through
 * `resolveContextModeDataRoot()` at the top of their override.
 *
 * maint/global-store — the same project opened under different Claude Code
 * profiles (`~/.claude`, `~/.claude-ime`, `~/.claude-devcom`, ...) used to
 * get a separate, divergent knowledge base per profile because the default
 * fell back to a profile-rooted `homedir() + sessionDirSegments` path.
 * `resolveContextModeDataRoot()` now NEVER returns null: with no override
 * env var set it resolves to a single OS-appropriate shared app-data
 * directory (not tied to any profile), so switching profiles no longer
 * loses project memory. `CONTEXT_MODE_HOME` is the current name for the
 * override; `CONTEXT_MODE_DATA_DIR` (#649) is kept as a back-compat alias —
 * both still mean "the parent directory under which `context-mode/` lives",
 * unchanged from the #649 contract.
 */

import { join, resolve } from "node:path";
import { accessSync, copyFileSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { hashProjectDirCanonical } from "../session/db.js";

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

export abstract class BaseAdapter {
  constructor(protected readonly sessionDirSegments: string[]) {}

  getSessionDir(): string {
    const dir = join(resolveContextModeDataRoot(), "context-mode", "sessions");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Default: build config dir from sessionDirSegments rooted at $HOME.
   *
   * Contract: ALWAYS returns an absolute path. Adapters with project-scoped
   * or non-home-rooted config dirs (cursor, vscode-copilot, jetbrains-copilot,
   * openclaw, opencode) override this and resolve their segments against
   * `projectDir` (or `process.cwd()` when omitted).
   *
   * NOT relocated by `CONTEXT_MODE_DATA_DIR` (#649). The platform owns its
   * settings.json / hooks.json / config.toml location — relocating that
   * would silently fork platform behaviour from the platform's own tooling.
   * Use `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`, etc. to move
   * platform-native config; use `CONTEXT_MODE_DATA_DIR` to move context-mode
   * storage independently.
   *
   * @param _projectDir Unused by the home-rooted default — accepted so
   *                    project-scoped overrides honor the same signature.
   */
  getConfigDir(_projectDir?: string): string {
    return join(homedir(), ...this.sessionDirSegments);
  }

  /**
   * Default: Claude Code convention. Most adapters override with their
   * own platform-specific instruction file name (AGENTS.md, GEMINI.md, ...).
   */
  getInstructionFiles(): string[] {
    return ["CLAUDE.md"];
  }

  /**
   * Default: <configDir>/memory/<projectHash>. Always absolute (configDir is
   * absolute by contract). Adapters with a different memory dir name (e.g.,
   * codex uses "memories" plural) override this.
   *
   * Issue #649: when `CONTEXT_MODE_DATA_DIR` is set, memory follows storage
   * to `<DATA_DIR>/context-mode/memory/` since persistent memory is
   * context-mode-owned state, not platform-native config.
   *
   * Issue #663: when `projectDir` is supplied the path is scoped via
   * `hashProjectDirCanonical(projectDir)` so two projects running in
   * parallel never share auto-memory contents. When omitted (legacy
   * callers), the unscoped path is returned for backwards compatibility.
   */
  getMemoryDir(projectDir?: string): string {
    const override = resolveContextModeDataRootOverride();
    const base = override
      ? join(override, "context-mode", "memory")
      : join(this.getConfigDir(), "memory");
    if (!projectDir) return base;
    return join(base, hashProjectDirCanonical(projectDir));
  }

  backupSettings(): string | null {
    const settingsPath = this.getSettingsPath();
    try {
      accessSync(settingsPath, constants.R_OK);
      const backupPath = settingsPath + ".bak";
      copyFileSync(settingsPath, backupPath);
      return backupPath;
    } catch {
      return null;
    }
  }

  abstract getSettingsPath(): string;
}
