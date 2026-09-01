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

**Verified 2026-08-21** against `origin/main` at commit `172e703`: upstream has
NOT fixed #1024. Evidence: `main` is 126 commits ahead of `origin/main` and only
3 behind, and those 3 are all `ci: update install stats` touching only
`stats.json`. Merge-base is `62684cf` (2026-08-18). Three targeted searches over
`main..origin/main` all returned empty:
`git log --oneline main..origin/main -- src/session/db.ts src/adapters/base.ts src/db-base.ts`,
`git log --oneline --grep="store" --grep="root" --grep="global" --grep="profile" -i main..origin/main`,
`git log --oneline --grep="1024" --grep="stale" --grep="liveness" -i main..origin/main`.
Consequence: there is no competing upstream fix to reconcile, and the retention
condition for the safety backup below is unchanged.

**Safety backup exists because of this risk.** The original backup at
`C:\Projects\_store-backup-20260818\` was DELETED on 2026-08-20 as superseded.
The current safety backup is `C:\Projects\_store-backup-20260820-premerge\`
(5457 files, 670 MB), taken immediately before the phase 2 store migration
(migration ran 2026-08-21). Retain it until at least one week of clean use
post-migration.
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

Developer Mode was enabled on 2026-08-21, so the 5x `EPERM` at `symlinkSync`
failures no longer occur. That unmasked 4 stale session-DB path assertions in
`tests/session-hooks-smoke.test.ts` and `tests/hooks/claude-stop.test.ts` (they
still expected the old `~/.claude`/`~/.codex`-scoped dir instead of the global
root); fixed in `4d08618`. The remaining known-variable failures are the
contention ones above, in `tests/core/server.test.ts` and `tests/executor.test.ts`
only.

If pursued, the fix belongs in worker/parallelism tuning in `vitest.config.ts` or in
the executor's shell-resolution robustness under contention. NOT in a dependency
revert and NOT in the test assertions, which are correct.

WARNING for future capture: a run captured via `powershell.exe` (Windows PowerShell
5.1) writes UTF-16LE and mangles vitest's unicode glyphs. Use `pwsh` (PowerShell 7).

### 8. Scheduled post-migration review - on or after 2026-08-28

Not urgent. This is the scheduled re-check of the 2026-08-21 store unification and
migration (phases 1-4 of `docs/plan-store-unification.md`). Do not act on it early;
the point is a week of normal use first.

**EXECUTED 2026-09-01. RESULT: FAILED.** The pre-merge backup at
`C:\Projects\_store-backup-20260820-premerge` and the per-profile stores must all
be RETAINED. Step 3 below (retiring the backups) is explicitly NOT authorized.
Findings A through F below are new, measured 2026-09-01; the four sub-steps are
kept as originally written, each annotated with its outcome.

**1. Confirm the per-profile stores are frozen.**
Phase 1 made hooks and the MCP server resolve one global store root for every
provider. The legacy per-profile stores were deliberately left on disk as a third
copy. Compare the newest mtimes under each `<config-dir>/context-mode/{sessions,content}`
against the global root (`%LOCALAPPDATA%\context-mode` on win32). Only the global root
should be moving. If a profile store is still being written to, phase 1 is incomplete
for whichever adapter owns it.

OUTCOME (2026-09-01): NOT confirmed frozen for two profiles. See Finding A and
Finding B below - `.claude-devcom` and `.claude-ime` were running pre-fix code
behind a stale version stamp, and several profiles carried a duplicate plugin
registration capable of writing profile-scoped stores independently of this
fork's code.

**2. Confirm the merged store is healthy.**
Run `scripts/merge-stores.ts` with NO `--apply` - every group should report as already
merged. Then spot-check `ctx_search` for content that previously existed only in a
profile store.

Already spot-checked once on 2026-08-21 and it passed. A `ctx_search` on this
project (`3186c0e9a3008ca2`) returned auto-memory entries dated 2026-07-20 and
2026-08-12. The global store held 7 `session_events` for this project before the
merge and the `.claude-ime` profile store held 174, so content spanning those
dates could not have come from the pre-merge global copy. This is strong evidence
rather than proof: it was not established that those exact rows were among the
stranded set. Re-run the check anyway.

OUTCOME (2026-09-01): FAILED. Today's dry run still shows rows the global store
does not have. See Finding D below for the group counts.

**3. Retire the backups, in this order.**
Only once 1 and 2 pass: delete `C:\Projects\_store-backup-20260820-premerge` (5457
files, ~670 MB, taken immediately before the phase 2 migration), then the per-profile
`context-mode` store directories, which are redundant once the global store is
confirmed authoritative.

This is SEPARATE from the retention condition in item 1. That one concerns upstream
issue #1024 and the legacy store at `~/.claude-devcom/context-mode/`, and it is
unchanged - verified 2026-08-21 that upstream still has no fix.

OUTCOME (2026-09-01): NOT EXECUTED. Explicitly not authorized - step 2 did not
pass. The backup and every per-profile store remain in place.

**4. Re-measure, do not assume.**
The migration verified clean on 2026-08-21 (765 groups, all no-op on re-run, FTS
intact, no duplicates or orphans, sources preserved). Re-run the checks rather than
trusting that record - see the standing warning below.

OUTCOME (2026-09-01): Re-measured as scheduled, not assumed. Result: FAILED, per
Findings A through D below. Findings E and F are unrelated cleanup found during
the same pass; Finding G is an additional result surfaced by the same dry run
that produced Finding D.

**New findings, all measured 2026-09-01:**

**Finding A - version-string trap. FIXED.** `.claude-plugin/plugin.json` was
bumped to 2.0.0 on 2026-08-19 09:43 (commit `7f61931`). The store-unification fix
landed later, 2026-08-20 12:18 (commit `958397a`). Profiles `.claude-devcom`
(installed 2026-08-19 10:22) and `.claude-ime` (installed 2026-08-19 11:27)
fetched inside that window, so their caches were stamped `2.0.0` while holding
pre-fix code. Because the marketplace entry pins no `ref` and the updater
compares version strings rather than commits, `/plugin` reported "already at the
latest version (2.0.0)" indefinitely and never refetched. Proven by SHA256 of
`hooks/session-db.bundle.mjs`: devcom and ime held `CC1495A2E6EAB8A8`, while
`.claude-personal`, `.claude-observix`, and the repo build all held
`CE90895FD66FF7E5`. Resolved on 2026-09-01 by renaming both stale cache
directories to `2.0.0.stale-20260901` and reinstalling; both now hash
`CE90895FD66FF7E5`. Note for the record: `claude plugin install` and `claude
plugin update` both still reported "already installed" and "already at the
latest version" during that reinstall, and the refetch happened only because the
cache directory was absent. A version bump to 2.0.1 is still recommended so that
other machines trapped in the same window can recover without a manual cache
rename.

**Finding B - duplicate plugin registration. CLEARED.** Several profiles had
both `context-mode@dskrypnyk` and `context-mode@context-mode` enabled at once,
the latter being a stale 1.0.169 upstream install from 2026-07-23 that predated
the fork's addition on 2026-08-24. Both register the same MCP namespace, which
hid the duplication. The stale server honoured `CLAUDE_CONFIG_DIR` and so wrote
profile-scoped stores. It was the user's own leftover, not installed by the
dskrypnyk-claude-kit. Cleared on 2026-09-01: the flags and old caches are gone
from every profile.

**Finding C - merge-script blind spot. FIXED.**
`LEGACY_ADAPTER_HOME_SEGMENTS` in `src/session/data-root.ts:110-128` was
platform-blind. Its entries `["kilo", [".config", "kilo"]]` and `["opencode",
[".config", "opencode"]]` (lines 124-125) resolve to XDG paths that are correct
on Linux and macOS but were wrong on Windows, where the real store is under
`%APPDATA%`. Consequence before the fix: `C:\Users\denys.skrypnyk\AppData\Roaming\opencode\context-mode`
holds 2968 .db files, 1232 of them with rows (session_events 2688, session_meta
1232, session_resume 672), and `scripts/merge-stores.ts` had never once seen it.
Every merge and count number recorded to date had been computed without it.

Fixed 2026-09-01 by adding a new exported `LEGACY_ADAPTER_APPDATA_SEGMENTS` in
`src/session/data-root.ts`, covering kilo and opencode, that all three
consumers now consult on win32: `candidateLegacyRoots()` in
`scripts/merge-stores.ts`, `adoptLargestLegacyDb` in `src/db-base.ts`, and
`enumerateAdapterDirs` in `src/session/analytics.ts`. `candidateLegacyRoots`,
`discoverGroups`, and `runMigration` gained optional trailing `appData`
parameters so that only `main()` reads ambient environment. One test
assertion in `tests/session/multi-adapter-stats.test.ts` changed from 16 to 18
entries on win32. `npm run build` passes, including `assert-bundle` and
`assert-asymmetric-drift`. Three bundles were rebuilt: `server.bundle.mjs`,
`cli.bundle.mjs`, `hooks/session-db.bundle.mjs`.

The change is UNSTAGED and UNREVIEWED as of this writing, and a code review is
in progress. Remaining entries other than kilo and opencode, notably `zed` and
`jetbrains-copilot`, are still unverified on Windows and were deliberately not
guessed at.

**Finding D - unmerged data remains, numbers superseded 2026-09-01.** A
post-fix dry run (after the Finding C fix, still unmerged) now reports 3530
groups, up from 562, because opencode is enumerated for the first time. Of
those, 1244 groups have a positive delta, totalling 13,738 rows that would be
added to the global store: session_events 11086, session_meta 1849,
session_resume 677, tool_calls 126. Only 13 groups have more than one legacy
source. Per-root figures, upper bound meaning the full delta credited to each
source and lower bound meaning the delta split evenly across a group's legacy
sources:

- `.claude-devcom`, 5 positive groups, upper 8799, lower 4865
- `.claude-ime`, 9 positive groups, upper 5724, lower 1790
- `.claude-observix`, 2 positive groups, upper 5321, lower 1387
- `.claude-personal`, 1 positive group, upper 4646, lower 1162
- `AppData\Roaming\opencode`, 1232 positive groups, 4536 exactly, never
  multi-source so the bounds coincide
- `.codex`, 0 positive groups, 0 rows

opencode accounts for 33 percent of all unmerged rows; the four `.claude-*`
roots together account for the other 67 percent. Check 2 of this item still
FAILS.

**Finding E - scaffolding removed.** `C:\Users\denys.skrypnyk\.vscode\context-mode`
(174 dbs, every one exactly 53,248 bytes, zero rows) and
`C:\Users\denys.skrypnyk\.config\JetBrains\context-mode` (15 dbs, every one
exactly 4,096 bytes, zero rows) were empty scaffolding for tools that never
populated them. On 2026-09-01 both were moved to
`%TEMP%\claude\removed-scaffold-20260901\`, not hard-deleted. The weekly temp
sweep clears that location after 7 days.

**Finding F - kilo dropped deliberately; opencode was a near miss.**
`C:\Users\denys.skrypnyk\AppData\Roaming\kilo\context-mode` was deleted to the
Recycle Bin at 06:45 on 2026-09-01 by something outside this work. Its row
counts were never measured. The user confirmed kilo is not installed and the
directory is being left dropped on purpose. No recovery is planned.

Separately, the sibling `%APPDATA%\opencode\context-mode` store, 404 MB, was
also deleted to the Recycle Bin, at 06:51 on 2026-09-01, by something outside
this work and never identified. It was noticed only because the post-fix dry
run found no opencode data. The user restored it from the Recycle Bin the
same day and it came back intact, 2968 db files, 404.9 MB. This was a near
miss: this store held the single largest block of unmerged data in the whole
migration (see Finding D) and was briefly the only copy, in the Recycle Bin,
while invisible to the tooling.

**Finding G - `.codex` is fully merged.** Its delta is zero in all four
columns in every group it appears in, including the one multi-source group it
participates in, verified by spot-check against the dry-run output. It is the
only legacy root retirable on data grounds alone today. Retiring it is a
separate decision that has not been taken, and nothing else has been retired.

**Before item 8 can be retried and closed:**
1. Review and commit the Finding C resolver fix - it is written and builds
   cleanly, but is unstaged and unreviewed, so landing it means review plus
   commit, not just re-running the dry run.
2. Run the actual merge, not just the dry run - the dry run has already been
   re-run post-fix and still shows unmerged data (Finding D), so the
   remaining blocker is the merge itself, not visibility into it.
3. Only then retire the backup and the per-profile stores, subject to item 1's
   separate retention still being satisfied.
4. Optionally bump the fork to 2.0.1 for the benefit of other machines.

### 9. ctx_fetch_and_index silently indexes empty SPA shells

Reproduced on this fork 2026-08-21. This is OUR defect, not a report of upstream's -
the reproduction below was run against this working tree.

Two URLs fetched through `ctx_fetch_and_index`, both reported `ok=2 ... err=0`, total
0.1 KB indexed:

    https://excalidraw.com/                                -> "Excalidraw Whiteboard"
    https://developer.apple.com/documentation/swiftui/view  -> "View | Apple Developer Documentation"

Only the page title was captured in each case. The Apple URL is substantial API
documentation; we indexed its title, stored nothing else, and told the caller it
succeeded. A caller gets a knowledge-base entry with no signal that the content is
missing, so the model stops looking instead of trying another route.

Root cause: the only emptiness guard on the fetch path is `markdown.length === 0`.
A JS-rendered shell converts to a small but non-zero string, so it passes.

Upstream has fixed this on its unreleased `next` branch (NOT on `origin/main`; as of
2026-08-21 `main` has only `ci: update install stats` commits we lack). The relevant
commits, all by Mert Koseoglu:

- `0ce043f` fix(fetch): stop reporting a JavaScript-rendered shell as a successful
  fetch. Adds `classifyExtraction()`, which accuses only when BOTH signals hold:
  under 200 bytes of text out AND under 2 percent yield. This is the smallest
  standalone fix and addresses the false success, though it converts the Apple case
  into an honest refusal rather than retrieving it.
- `8476db7` feat(fetch): rung 2 recovers SPA pages browser-free, via the page's `.md`
  sibling then the host's `llms.txt`. This is what actually retrieves the Apple page.
- `5b9c00c` feat(fetch): extract the article instead of transliterating the page.
  Classifies each block as content or template by whether it repeats across other
  pages of the same host, rather than by any byte or link-density threshold.
- `e31360d` docs: removes the tool description line telling callers SPA pages cannot
  be fetched. Our `ctx_fetch_and_index` description still carries that line.

Upstream's measurements, from `docs/research/fetch-ladder-2026-08-12.md` and
`fetch-extraction-2026-08-12.md` on `origin/next`:

- 36 documentation pages probed. 4 had the article absent from the plain HTTP
  response. 4 of 4 were recovered browser-free. 0 of 36 needed a headless browser.
- Sending `Accept: text/markdown` on the SAME request, no extra round trip, fixed six
  platforms outright: Stripe, GitBook, Cursor, Resend, Polygon, Mintlify.
- No byte or link-density threshold can work: 28.3 percent link-only lines on
  docs.stripe.com versus 0.3 percent on resend.com.
- Two acceptance traps found: developer.apple.com serves its `.md` with an empty
  Content-Type and an HTML comment as its first bytes; angular.dev answers a missing
  `.md` with HTTP 200 and the SPA shell.

Adoption note: a wholesale merge of `next` is NOT clean - `git merge-tree` reports
conflicts in `src/server.ts` and `server.bundle.mjs`, because both lines rewrote
`src/server.ts` independently. `0ce043f` alone may be cherry-pickable; that has not
been assessed. The rest is a deliberate integration, not a cherry-pick.

Not related to items 1 to 8. The other two commits on `next` (`c94e8fc` and its
same-day revert `e1d9448`) concern upstream's hosted billing bridge, which this fork
does not have.

Update 2026-08-21: `0ce043f` has been adopted. It cherry-picked cleanly as `fc7cfaa`,
with bundles rebuilt in `1c0dd5b`. Its test `tests/core/fetch-shell-detection.test.ts`
passes 16/16 here.

Thresholds as implemented: `SHELL_MAX_TEXT_BYTES = 200`, `SHELL_MAX_YIELD = 0.02`,
flagging a shell only when BOTH hold. Checked by arithmetic, not by re-fetching:

- excalidraw.com: 21 bytes of markdown from 6862 bytes of source is a 0.31 percent
  yield.
- developer.apple.com/documentation/swiftui/view: 36 bytes from 17486 is a 0.21
  percent yield.

Both are now under the 200-byte floor and the 2 percent yield floor, so both return
`fetch_error` with reason `shell` instead of reporting success.

Update 2026-08-21: the rest of the ladder has been ported. Item 9 is CLOSED
apart from the two junk store entries noted at the end of this item.

Phase 1, `395e017` feat(fetch): add block classification and page store,
unwired - ported `src/fetch/blocks.ts` and `src/fetch/page-store.ts` verbatim
from `5b9c00c`. 28 tests including the lossless invariant
`reassemble(splitBlocks(x)) === x`.

Phase 2, `707accd` + `5a510d4` - `src/fetch/extract.ts` plus the full route
wire protocol. During this phase a real regression was caught before shipping:
reconciling `indexFetched` alone would have run `extractAndStore` (a markdown
block splitter) over raw JSON and text bodies, and an allTemplate verdict
would have hit the refuse branch BEFORE `store.indexJSON` / `store.indexPlainText`,
silently ending JSON indexing. Fixed by threading `route` end to end (`emit()`
stdout line 2, `FetchOneResult.route`, `parseFetchRoute`, `fetchOneUrl`
parsing) and covered by `tests/core/fetch-route-skip.test.ts`.

Phase 3, `57b9ed1`, `9b3ab2e`, `fbdda74`, `413f589` - `Accept: text/markdown`
content negotiation, rung 2 (`.md` sibling then `llms.txt`), the tool
docstring, and the bundle rebuild.

Parts most likely to be broken by a future change:

- The happy path costs exactly ONE request. `tests/core/fetch-ladder-rungs.test.ts`
  asserts `r.requests` equals `["/docs/view"]` when HTML converts to an
  article. Rungs past 1 fire only when rung 1 came back empty.
- Two acceptance traps are handled STRUCTURALLY, not by sniffing:
  `isMachineReadable` requires status 200, a content-type not containing
  "html", and a body not containing `<!doctype html` or `<html>`. It
  deliberately does NOT check for a leading `#`, because
  developer.apple.com serves its `.md` with an empty Content-Type and an
  HTML comment first. angular.dev answers a missing `.md` with HTTP 200
  plus the SPA shell, which the same check rejects.
- `getPageStore()` resolves `join(dirname(getStorePath()), "fetch-pages.db")`
  and therefore inherits our unified store root. Upstream's own
  `getStorePath()` is the stale profile-scoped version and must never be
  taken in a future merge. Guarded by
  `tests/session/fetch-page-store-path.test.ts`, which was verified to
  actually fail when `getPageStore` is pointed at a config dir.
- Deliberately NOT ported: upstream's measurement scripts (one-off
  diagnostics with hardcoded /tmp paths), and an unrelated
  retrieval-marker/analytics hunk bundled into `8476db7` by squashed
  history.
- The docstring deliberately omits upstream's "4 of 36 pages" measurement
  claim, because we did not re-run their measurement. Capability claims
  match what shipped.

`e31360d` (tool-description rewording) is deliberately skipped: it describes a
fetch ladder we do not have.

Remaining junk: the SPA-shell reproduction above created two store entries,
`spa-test-excalidraw` and `spa-test-apple-swiftui`, that cannot be removed -
`store.ts` only deletes a source as a side effect of re-indexing the same
label (the `#stmtDeleteSourcesByLabel` dedup path), there is no exposed
per-source deletion command. Add one before relying on being able to clean up
a bad index entry.

End-to-end verification, 2026-08-21: the ported ladder was exercised against
real pages using an ISOLATED scratch store (`CONTEXT_MODE_HOME` pointed at a
temp dir, redirection proven before any fetch). Live-store file counts were
unchanged at 2019 content / 3018 sessions before and after.

    https://developer.apple.com/documentation/swiftui/view
      rung 2a, 5593 bytes of real article (protocol description, code samples,
      Topics). This is the page that returned 36 bytes and reported success
      before the port.
    https://excalidraw.com/
      refused, with a diagnosis: 21 bytes of text from 6862 received, 0.31
      percent yield. Nothing indexed. Correct - it is an application, not a
      document.
    https://docs.stripe.com/api/charges/object
      rung 1, 11688 bytes, ONE request.
    https://resend.com/docs/introduction
      rung 1, 32797 bytes, ONE request.

Two caveats on the above, recorded honestly:

- The Resend preview is dominated by JSX icon-component source before any
  prose. This is legitimate site-authored markdown served at rung 1, not a
  misclassification, but it was not confirmed from a 3 KB preview whether the
  introduction prose sits deeper in the 32 KB indexed document.
- Request counts were inferred from the rung labels in each response, not
  instrumented directly.

### 10. Upstream 8476db7 deletes two shipped fixes - do not merge it wholesale

Found 2026-08-21 while porting the fetch ladder. Upstream's `8476db7` on `origin/next`
carries two deletions its commit message never mentions. Both remove fixes that exist
on BOTH branches, inherited from the shared ancestor `589d821` (v1.0.169):

- The `appendRetrievalBytes` bridge is removed from `src/server.ts`, including the
  comment explaining why it exists: the PostToolUse hook never fires for the plugin's
  own MCP tools, so `bytes_retrieved` read 0 of 124454 in production. Introduced by
  `320ed3e`.
- `getConversationWindowStats` is reverted to the older `projectDirForSid` call shape,
  which the fix's own comment documents as crediting the whole worktree's kept-out
  bytes while counting only one session's retrieval. Introduced by `549308c`.

Ancestry confirms this is a real in-branch revert rather than a base artifact:
`git merge-base main 8476db7` is `589d821`, and both `320ed3e` and `549308c` are
ancestors of it, so upstream's own `next` had these fixes and this commit removes them.
`git log --oneline -S appendRetrievalBytes main..origin/next` returns only `8476db7`.

Our tree still has both fixes: `src/server.ts:60,973` and `:4762,4764`, with
`src/session/retrieval-marker.ts:41` and `src/session/analytics.ts:1475` defining them.
Verified by `tests/session/retrieval-marker.test.ts` and
`tests/session/real-bytes-stats.test.ts`, 24 tests passing.

Consequence: the fetch-ladder port took only the ladder hunks from `8476db7`. A future
merge or cherry-pick of that commit in full would silently reintroduce both bugs. If
upstream's `next` is ever merged, these two deletions must be rejected in the conflict
resolution, the same way upstream's stale `getStorePath()` must be.

No conflict with our own `6663f75`, which changes `getRealBytesStats`'s internal file
arbitration, a different function.

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
