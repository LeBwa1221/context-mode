# context-mode fork - session handoff

Trimmed 2026-08-19: removed the completed-work narrative for goals 1-4 and the
per-branch merge status (all merged into `maint/integration` and pushed to `fork`,
done). Only still-actionable items remain below.

## Repo/remote facts needed to resume

- Main working tree: `C:\Projects\context-mode`, on `maint/integration` -
  this is the main line, all other maint branches are merged into it.
- Remotes: `origin` = upstream `mksglu/context-mode`, `fork` =
  `https://github.com/LeBwa1221/context-mode.git`. All branches and tags are pushed
  to `fork`.
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

### 5. `f*.tmp` test-leak cleanup
`f0.tmp`/`f1.tmp`/`f2.tmp` regenerate at the worktree root on every `npm run build`,
leaking from `tests/core/server.test.ts`. Never tracked, safe to delete, but the
leak itself is still not fixed.

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
