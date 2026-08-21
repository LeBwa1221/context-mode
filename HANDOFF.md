# context-mode fork - session handoff

Trimmed 2026-08-19: removed the completed-work narrative for goals 1-4 and the
per-branch merge status (all merged into `maint/integration` and pushed to `fork`,
done). Only still-actionable items remain below.

## Repo/remote facts needed to resume

- Main working tree: `C:\Projects\context-mode`, on `main` - this is now the
  single long-lived branch. `main` tracks `fork/main`. `maint/integration` was
  retired (deleted locally and on fork) on 2026-08-20; its history is in `main`.
- Remotes: `origin` = upstream `mksglu/context-mode`, `fork` =
  `https://github.com/LeBwa1221/context-mode.git`. All branches and tags are pushed
  to `fork`. `remote.pushDefault` is set to `fork`.
- Publishing fact: the `dskrypnyk` marketplace (repo
  `LeBwa1221/dskrypnyk-claude-kit`) resolves `context-mode` from
  `LeBwa1221/context-mode` with NO ref pinned, so it reads the fork's default
  branch `main`. Pushing anywhere else does not ship.
- Worktree folders `context-mode-netsave`, `context-mode-perf`,
  `context-mode-prompt-diet`, `context-mode-upstream-picks`, `_base`, and
  `_verify-base` are being deleted (parallel cleanup) - do not look for them. Their
  branches still exist on `fork`; to recreate a worktree for one, `git worktree add
  <path> <branch>` from `fork`.

## LEFT TO DO, in priority order

### 1. Upstream issue #1024 - stale-session cleanup lacks a liveness/PID check
Real and open on both sides. Our change dropped the "WAL non-empty + untouched >1h
= dead" heuristic and now keys stale-session cleanup off the main DB file's mtime
alone, with NO liveness or PID check. That is a weakened heuristic, not a fix.

Upstream's maintainer re-reviewed #1024 and found the naive PID approach unworkable
(WAL headers carry no PID, DBs are hash-named with no owner sidecar,
`isProcessAlive` at `src/store.ts:207` is dead code) and is steering toward a
liveness probe before unlink or an owner-pidfile scheme. Stale-cleanup deleting a
live-but-idle session is a data-loss bug and matters MORE for our shared global
store than it does upstream. Do not record this as fixed.

**Safety backup exists because of this risk:** `C:\Projects\_store-backup-20260818\`
is a copy of the legacy profile store
(`C:\Users\denys.skrypnyk\.claude-devcom\context-mode\`), taken 2026-08-18 including
`-wal`/`-shm` sidecars (a bare `.db` copy taken mid-write can be torn; db+wal is
recoverable). Verified 142 files, 126,158,750 bytes, aggregate MD5 across all `.db`
files `4ee877970681ef05f301e7c9c239c1bf`, identical on both sides. It protects
against accidental deletion and against exactly the #1024 stale-cleanup risk, but it
is on the SAME DISK as the original - not protection against disk loss.
**Do NOT delete the legacy `.claude-devcom` store until the main projects have been
reopened under the fork and the data confirmed adopted** into the global store
(adoption is lazy, fires on first open of each project - see `adoptLargestLegacyDb`
at `src/db-base.ts:746`).

### 2. Remaining upstream PR triage
Still untriaged: db/store **#970, #980, #898**. Routing-block **#918, #1034**.
Snapshot **#907**.

Already adopted, do NOT re-do: **#871, #963** (plus #947, #867) landed via
`ed50f39`; **#1056** landed via `8317c6b`.

**#927** remains do-not-merge, diff-only: its intent (downgrade the WebFetch
hard-deny to a once-per-session advisory) is already implemented and merged via
`maint/perf`, independently. A local reference branch `pr-927` @ `e5b93ee` exists.
Do NOT merge it - diff it against our implementation only to check whether it
handles a case we missed.

Adopt by RE-IMPLEMENTING against our code, not by cherry-picking; credit the author
in the commit body (`Adopted from upstream PR #N by @handle`), and actually write
that line - missing credits are why any total PR-count claim in this history has
been unprovable.

### 3. Eager runtime probe in `src/adapters/pi/mcp-bridge.ts:88`
Fires per bridge start. Same fix pattern already applied elsewhere (lazy memoized
singleton, see `getRuntimes()` in `src/runtime.ts` for the precedent) - just not
done here yet.

### 4. `analytics.ts` stale-adapter-path claim - UNVERIFIED, carried forward
Possible loose end from the global-store move: `analytics.ts`'s hardcoded adapter
segment map was found pointing at the WRONG (stale, pre-fix) directory for
`gemini-cli`, `antigravity`, and `antigravity-cli` once those adapters began
resolving to the new global root. A separate triple-COUNT bug was deduped by
resolved path, but it's not confirmed the stale-PATH half was fixed too - deduping
stale paths still reads the wrong directory if so. This is untouched; do not assume
it was fixed as a side effect of anything else done in this history.

### 5. `f*.tmp` test-leak cleanup - FIXED 2026-08-21
Root cause found and fixed: `tests/executor.test.ts` ("Temp Cleanup Resilience >
concurrent executions all return valid results (EBUSY resilience)"), not
`tests/core/server.test.ts` as previously believed. That test ran JS code writing
`f0.tmp`/`f1.tmp`/`f2.tmp` via `process.cwd()`, and the default `executor` in that
file has no `projectRoot` override, so `PolyglotExecutor` (by design, Issue #788 -
every language runs with cwd = project root unless a `cwd` override is passed)
resolved that to the repo root. Confirmed empirically: `npm run build` alone does
NOT regenerate the files; `npx vitest run tests/executor.test.ts` does. Fixed by
passing `cwd: scratch` (a `mkdtempSync(join(tmpdir(), "ctx-ebusy-test-"))` dir,
same pattern used elsewhere in the file) into the `executor.execute` calls, with
`rmSync(scratch, { recursive: true, force: true })` in a `finally`. `text.txt` and
`baseline.xml` at the repo root are unrelated - manual redirected output from a
`merge-stores` dry run and a PowerShell session-stats snapshot, with no in-repo
generator writing those literal filenames; left alone.

### 6. Hook vs server store-root divergence - real session data lands in the profile dir

Found 2026-08-20. Not covered by any existing item or upstream issue. Undocumented
until now.

CORRECTION (2026-08-20, same day): the paragraph below originally claimed
`CONTEXT_MODE_DIR` / `STORAGE_ROOT_ENV` was the hook-side override and part of
the divergence. That was wrong and got copied into
`docs/plan-store-unification.md` too. `CONTEXT_MODE_DIR` is a SHARED
storage-override layer (`resolveSessionStorageDir` /
`resolveContentStorageDir` / `resolveStatsStorageDir` in `src/session/db.ts`)
composed IDENTICALLY by both hooks (`hooks/session-helpers.mjs:382-388`) and
the server (`src/server.ts:594-596`) - it was never part of the bug. The real
divergence was solely `resolveDefaultSessionDir`'s own default branch (no
override, no legacy env) building a profile-scoped path via
`resolveConfigDirForDefaultSession(configDir, configDirEnv, env)`, while
`BaseAdapter.getSessionDir()` used `resolveContextModeDataRoot()`. First
fixed for Claude Code only at commit `4d1272e`, then extended to EVERY
provider at commit `958397a` (phase 1, see `docs/plan-store-unification.md`)
after investigation found no functional requirement for platform-rooted
stores, and found that vscode-copilot's `getSessionDir()` override diverged
from its own hooks for real (see below), not just Claude Code's.

The fork had independent store-root resolvers for every provider that were
never unified:

- MCP server: `resolveContextModeDataRoot()`, extracted to
  `src/session/data-root.ts` and re-exported from `src/adapters/base.ts`
  (the extraction avoids a cycle: `base.ts` already imports
  `hashProjectDirCanonical` from `src/session/db.ts`). Consumed via
  `BaseAdapter.getSessionDir()` (`src/adapters/base.ts`) and `src/server.ts`.
  Resolves to the GLOBAL root (on win32, `%LOCALAPPDATA%\context-mode`).
  Honors `CONTEXT_MODE_HOME` / `CONTEXT_MODE_DATA_DIR`.
- Hooks: `resolveDefaultSessionDir()` in `src/session/db.ts`, reached from
  `hooks/session-helpers.mjs:382-388` (`resolveSessionDir`) and `:408-419`
  (`getSessionDBPath`, `getSessionEventsPath`). Resolved PROFILE/PLATFORM
  -SCOPED to `~/<CLAUDE_CONFIG_DIR or .claude>/context-mode/sessions` for
  Claude Code, and analogously `~/.gemini`, `~/.cursor`, `~/.kiro`,
  `~/.config/JetBrains`, etc. for every other platform with a hook OPTS
  entry.
- Additionally, five adapters (codex, opencode, vscode-copilot, copilot-cli,
  kimi) overrode `getSessionDir()` on the SERVER side too, with their own
  non-global fallback (`~/.codex`, XDG/APPDATA-rooted, `.github`-or-
  `~/.vscode`, COPILOT_HOME-aware, `~/.kimi-code`) when no
  CONTEXT_MODE_HOME/CONTEXT_MODE_DATA_DIR override was set.
  vscode-copilot's override DIVERGED FOR REAL from its own hooks:
  `VSCodeCopilotAdapter.getSessionDir()` preferred project-local
  `.github/context-mode/sessions` when a `.github` dir existed in cwd, while
  `VSCODE_OPTS` (`configDirEnv: undefined`) always resolved `~/.vscode`
  regardless. The other four adapters' overrides happened to match their own
  hooks, but still split from every OTHER platform's storage root.

Consequence (before the phase 1 fix): `hooks/posttooluse.mjs:43`,
`hooks/sessionstart.mjs:197`, and `hooks/stop.mjs:27` (and the equivalent
hooks for every other platform) wrote real `session_events` and `tool_calls`
into a profile/platform-scoped DB on every session, unconditionally, while
`ctx_search` / `ctx_stats` read the global store. This was the default code
path, not a misconfiguration.

Why it looks migrated but is not: `adoptLargestLegacyDb()` (`src/db-base.ts:746`)
does a ONE-SHOT copy gated by `if (existsSync(newDbPath)) return false;`
(`src/db-base.ts:755`). Once the global DB exists, adoption never re-runs, and
hook writes immediately diverge from the copied snapshot again.

How it happened: the global-store commits `3388883`, `8effcef`, `1459833`
changed `src/` only. `1459833` added the adoption calls but left
`resolveDefaultSessionDir`'s own root computation untouched. No `hooks/` path
logic was updated.

Measured divergence on 2026-08-20 (project `cc85b9c1aa263b44`): legacy content DB
had 1441 chunks vs 606 in the global copy (835 chunks existing only in the
profile store), while the global copy had rows the legacy one lacked
(`tool_calls` 44 vs 41, `session_resume` 1 vs 0). Neither side is a superset.

TRAP - phase 1 (commits `4d1272e` then `958397a`) unified the resolver for
EVERY provider. The global DBs already exist for most projects, so
`adoptLargestLegacyDb` does not fire, and the pre-existing profile/platform
-side data (Claude Code AND every other platform, including the ones
`adoptLargestLegacyDb`'s scan can never reach - see
`docs/plan-store-unification.md`'s phase 2 NEW REQUIREMENT: opencode/
jetbrains-copilot's nested config paths, vscode-copilot's project-relative
`.github` store, and any env-var-relocated store) is still stranded there -
phase 1 was explicitly scoped to stop new writes from diverging further, not
to migrate what already diverged. Phase 2 (a real merge, not a redirect) is
still not started.

Fix sites (phase 1, done): `hooks/session-helpers.mjs` (all platform OPTS)
and `src/session/db.ts` (`resolveDefaultSessionDir`, now unconditional - no
per-platform scoping), plus removal of the five `getSessionDir()` overrides
in `src/adapters/{codex,opencode,vscode-copilot,copilot-cli,kimi}/index.ts`.
`getConfigDir()`/`getSettingsPath()` on all five are untouched - only the
session/content STORE root moved. `CONTEXT_MODE_HOME`/`CONTEXT_MODE_DATA_DIR`
still win for every provider (issue #649's actual rationale, an env-var
escape hatch for CI/dev-container/NFS users, is preserved).

Also confirmed while investigating: the `stats-pid-<N>.json` files in
`~/.claude-personal` and `~/.claude-observix` are STALE artifacts from a
pre-`3388883` server build, not active writes. `getStatsFilePath()`
(`src/server.ts:1064`) now routes through the global root.

### 7. Full-suite failures are contention artifacts, not regressions

Established 2026-08-21 by bisect. Do not re-derive this.

The full suite (`npm test`, ~4849 tests) produces a DIFFERENT failure count on every
run of identical code. Measured: 19, 11, 14, and 45 failures across four runs, with
different test names each time. The variance is concentrated in two files:

- `tests/core/server.test.ts` - spawns real MCP server child processes. Measured at
  2, 6, 8, 10 and ~16 failures.
- `tests/executor.test.ts` and `tests/executor/cwd-override.test.ts` - 29 failures in
  the worst run.

Both pass 100% in isolation. Verified twice each at vitest 4.1.11 and, force-pinned,
at 4.0.18: `Test Files 2 passed | Tests 123 passed | 31 skipped`. The vitest bump in
`ce989cc` is NOT the cause; that was bisected and cleared.

Failure signatures are resource starvation, not logic: empty `VAR=` in every
environment-passthrough test, a PowerShell `ParserError` on
`"C:\Program Files\nodejs\node.exe" --version` (missing `&` call operator), CRLF
`'apple\r'` where LF was expected, `awaitRpc timeout`, `EBUSY: resource busy`, and
`Timed out after 10000ms waiting for process tree to spawn`.

`vitest.config.ts` already documents the mechanism: `maxWorkers: 3` with the comment
"Cap parallel workers to prevent fork exhaustion (#258)... Benchmarked: 3 workers =
2.8x speedup with near-zero crashes (vs unlimited = 3.7x but 6-7 worker kills/run)",
plus a raised `teardownTimeout` for Windows native-addon cleanup races.

Compounding factor on this machine: every open Claude Code session runs context-mode's
own MCP server as a node process, so the suite competes with the thing running it. A
trustworthy number requires closing every Claude Code window first.

Separately known-environmental (6 failures, unrelated to the above): 5x `EPERM` at
`symlinkSync` needing Windows Developer Mode, plus 1 in `tests/hooks/claude-stop.test.ts`.

If pursued, the fix belongs in worker/parallelism tuning in `vitest.config.ts` or in
the executor's shell-resolution robustness under contention. NOT in a dependency
revert and NOT in the test assertions, which are correct.

WARNING for future capture: a run captured via `powershell.exe` (Windows PowerShell
5.1) writes UTF-16LE and mangles vitest's unicode glyphs. Use `pwsh` (PowerShell 7).

## Standing warning: re-measure, do not trust prior numbers

Every number and every "regression" label recorded in this history's past sessions
turned out to need re-checking against the real thing at least once - several
specific past claims (commit counts, byte totals, "regression" diagnoses) were
found wrong on re-verification, in both directions. The recurring failure mode was
measuring a proxy (source text, a synthetic test harness, a stubbed function, a
report from another agent) instead of the real thing. Before quoting any number or
status from this file (or from an older handoff), re-measure it directly - `git
log`, `git status`, running the actual test, calling the actual function - rather
than repeating it.
