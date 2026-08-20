# Plan: unify the store root (HANDOFF item 6)

Status: phase 1 done, covering ALL providers (commits 4d1272e then 958397a,
then a code-review fixup round, 2026-08-20). Phases 2-4 not started.
Created 2026-08-20.
Fixes HANDOFF.md item 6 (hook vs server store-root divergence).

## BREAKING CHANGE (no CHANGELOG file exists in this repo - recorded here)

`CODEX_HOME`, `COPILOT_HOME`, `KIMI_CODE_HOME`, `GEMINI_CLI_HOME`, and
`CLAUDE_CONFIG_DIR` no longer relocate context-mode session/content storage.
Before phase 1, setting one of these env vars moved BOTH that platform's own
config (settings/hooks/config.toml) AND its context-mode session DB. As of
phase 1, they still relocate platform-native config exactly as before, but
context-mode storage always resolves the single shared global root
(`resolveContextModeDataRoot()`), regardless of these env vars.

Anyone who was relying on `CODEX_HOME`/`COPILOT_HOME`/`KIMI_CODE_HOME`/
`GEMINI_CLI_HOME`/`CLAUDE_CONFIG_DIR` to keep context-mode storage off an NFS
home, inside a dev container, or on a separate volume must switch to
`CONTEXT_MODE_HOME` (or its back-compat alias `CONTEXT_MODE_DATA_DIR`)
instead - that is now the ONLY env var that relocates context-mode storage,
for every provider. The old codex adapter comment ("parity with the
copilot-cli/kimi/opencode adapters... continues to steer session storage the
way it always has") explicitly promised the opposite of this; that promise
is now void, on purpose, per the scope decision above.

## Decision

Single global, project-keyed store. Profile-scoped resolution is REMOVED, not
merely bypassed, so it cannot be reintroduced. One merged history per project,
regardless of which host profile the work was done from. This matches how
claude-mem keys memory (by project, not by profile).

The project key already has no profile component: DB filenames are
`hashProjectDirCanonical(projectDir)`, e.g. sha256("c:/projects/context-mode")
sliced to `3186c0e9a3008ca2`, and that same filename already appears in
multiple stores. Only the ROOT is profile-dependent. That narrows the fix and
makes the data migration pairwise by filename, with no key mapping required.

## Ground truth this plan is built on

Resolvers:
- Server/adapters: `resolveContextModeDataRoot()`, extracted during phase 1
  to src/session/data-root.ts and re-exported from src/adapters/base.ts (the
  extraction avoids a cycle: base.ts already imports hashProjectDirCanonical
  from src/session/db.ts). Used by `BaseAdapter.getSessionDir()` and
  src/server.ts. Global root; on win32 `%LOCALAPPDATA%\context-mode`.
- Hooks: `resolveDefaultSessionDir()` (src/session/db.ts), reached from
  hooks/session-helpers.mjs:382-388 and :408-419. Before phase 1, resolved
  PROFILE-SCOPED to `~/<CLAUDE_CONFIG_DIR or .claude>/context-mode/sessions`
  for Claude Code.

CORRECTION (post phase 1): an earlier version of this doc claimed
`CONTEXT_MODE_DIR` was a different, hook-only override and part of the
divergence above. That was wrong (it was carried over from a HANDOFF.md
error, now corrected there too). `CONTEXT_MODE_DIR` / `STORAGE_ROOT_ENV` is a
SHARED storage-override layer (`resolveSessionStorageDir` /
`resolveContentStorageDir` / `resolveStatsStorageDir`, all in
src/session/db.ts) already composed identically by both hooks
(hooks/session-helpers.mjs:382-388) and the server (src/server.ts:594-596).
It was never part of the divergence and phase 1 left it untouched.

Also discovered during phase 1 implementation: not every platform's adapter
used the global default. Five adapters deliberately overrode
`getSessionDir()` with their own non-global fallback when no
CONTEXT_MODE_HOME/CONTEXT_MODE_DATA_DIR override was set - codex, opencode,
vscode-copilot, copilot-cli, kimi. The first pass of this fix (commit
4d1272e) scoped the resolver change to `configDirEnv === "CLAUDE_CONFIG_DIR"`
only, on the assumption that those five adapters' hook-side defaults already
matched their own override, and that unifying the remaining platforms
(gemini-cli, cursor, kiro, jetbrains-copilot, qwen-code, antigravity) was out
of scope.

CORRECTION (scope decision, same day): that assumption was wrong for
vscode-copilot, and the narrower scoping was itself abandoned. Investigation
found:
- No functional requirement exists for platform-rooted stores. No host CLI
  (codex, opencode, VS Code Copilot, copilot-cli, kimi) reads or writes
  inside `<platform-root>/context-mode/sessions/` - that directory is
  context-mode-owned in every case, never platform-native state.
- vscode-copilot DIVERGED FOR REAL: `VSCodeCopilotAdapter.getSessionDir()`
  preferred project-local `.github/context-mode/sessions` when a `.github`
  dir existed in cwd, while its own hooks (`VSCODE_OPTS` in
  hooks/session-helpers.mjs has `configDirEnv: undefined`) always resolved
  `~/.vscode/context-mode/sessions` regardless. The "already matched" claim
  in the previous version of this doc was WRONG for this adapter.
- Issue #649's actual rationale (an env-var escape hatch for CI/dev-container/
  NFS users relocating storage) is satisfied, not violated, by removing the
  platform-rooted fallbacks: `CONTEXT_MODE_HOME`/`CONTEXT_MODE_DATA_DIR` still
  win for every adapter (`BaseAdapter.getSessionDir()` already checks them via
  `resolveContextModeDataRoot()` before falling to the OS-default).
- Commit 8effcef (which originally added these five overrides) restored
  platform roots specifically so "the TS server and the bundled hook runtime
  don't disagree about where a project's DB lives." A single global root
  achieves that goal by construction, for every provider, which is why the
  overrides could be removed rather than kept and reconciled.

Decision: unify ALL providers onto the single global root (commit 958397a).
`resolveDefaultSessionDir`'s default branch resolves
`resolveContextModeDataRoot()` unconditionally now - no per-platform scoping.
The five `getSessionDir()` overrides (codex, opencode, vscode-copilot,
copilot-cli, kimi) were deleted; `getConfigDir()`/`getSettingsPath()` on all
five are untouched (platform-native config still lives where each host tool
expects it - only the session/content STORE root moved).

Bundling (this is NOT a staleness trap):
- hooks/session-db.bundle.mjs is generated by esbuild from src/session/db.ts
  (package.json:85 `bundle`), invoked by `build` (package.json:82) and checked
  by `assert-bundle` (package.json:83). Both the bundle and
  hooks/session-helpers.mjs are tracked in git. A change to src/session/db.ts
  propagates on `npm run build`.
- hooks/session-helpers.mjs is hand-written and only re-exports/wraps the
  bundle.

Scale (measured 2026-08-20, 976 distinct project DB filenames):
- 529 keys exist ONLY in a profile store (never adopted).
- 443 keys exist ONLY in the global store.
- 11 keys exist in both, or in multiple profiles, and therefore need a real
  merge.

The 11 overlapping keys:

| key | stores present | note |
|---|---|---|
| sessions/bfbc4b0a45add782.db | global, ime, devcom, personal, observix | 5-way |
| content/bfbc4b0a45add782.db | global, ime, devcom | |
| content/cc85b9c1aa263b44.db | global, ime, devcom, observix | |
| sessions/cc85b9c1aa263b44.db | global, ime, devcom, observix | |
| sessions/fd02e10d0bf808e8.db | global, ime, devcom, personal, observix | 5-way |
| content/fd02e10d0bf808e8.db | global, devcom, personal | |
| content/7c50e15dd21741e4.db | global, devcom | |
| sessions/7c50e15dd21741e4.db | global, ime, devcom | |
| sessions/3186c0e9a3008ca2.db | global, ime | global is SMALLER |
| sessions/77240b47257a3e19.db | global, devcom, personal | global is SMALLER |
| sessions/004ef76bd88ce1ba__004ef76b.db | global, personal | global is SMALLER |

session_events / session_meta row counts for the 7 overlapping session DBs:

| project | global | ime | devcom | personal | observix |
|---|---|---|---|---|---|
| 7c50e15dd21741e4 | 753/3 | 1022/4 | 746/2 | - | - |
| 3186c0e9a3008ca2 | 7/1 | 174/2 | - | - | - |
| 77240b47257a3e19 | 5/1 | - | 69/2 | 67/21 | - |
| 004ef76bd88ce1ba | 4/1 | - | - | 17/5 | - |
| bfbc4b0a45add782 | 3390/15 | 1416/2 | 388/1 | 373/7 | 1183/3 |
| cc85b9c1aa263b44 | 1039/6 | 1016/3 | 1039/8 | - | 1014/3 |
| fd02e10d0bf808e8 | 1739/14 | 1257/5 | 1391/11 | 2503/14 | 404/1 |

No copy is a strict superset of another.

## Merge feasibility, per table

Sessions DB (src/session/db.ts:877-927):

| table | key | merge strategy |
|---|---|---|
| session_events | `id` AUTOINCREMENT, no UNIQUE | dedupe on derived `(session_id, type, data_hash)`; `data_hash` (db.ts:892) is app-level only, not enforced, so this needs code not a DB constraint |
| session_meta | `session_id` PRIMARY KEY | union keys, but `event_count`/`compact_count`/`last_event_at` are aggregates and must be RECOMPUTED after the events merge, not copied |
| session_resume | `session_id` UNIQUE | upsert, keep latest `created_at` |
| tool_calls | PK `(session_id, tool)` | `calls`/`bytes_returned` are counters and must be SUMMED, not overwritten, or the merge undercounts |

Content DB (src/store.ts:517-556):

| table | key | merge strategy |
|---|---|---|
| sources | `id` AUTOINCREMENT, no UNIQUE on `content_hash` | dedupe on `(label, content_hash)`; ids collide across copies and must be remapped |
| chunks, chunks_trigram | FTS5 virtual, no natural key | CANNOT be byte-merged. Must re-INSERT through the normal write path so FTS rebuilds, remapping `source_id` to the merged `sources.id` |
| vocabulary | `word` PRIMARY KEY | free, dedupes itself |

Consequence: the migration is a READ-AND-REPLAY through existing insert
paths, not a file or table copy.

## Phases

### Phase 1 - stop the bleeding (DONE, commits 4d1272e then 958397a)

Make the global root the ONLY root, for every provider.

1. In src/session/db.ts, `resolveDefaultSessionDir`'s default branch now
   resolves `resolveContextModeDataRoot()` unconditionally, for every
   platform - no per-platform scoping (4d1272e's `configDirEnv ===
   "CLAUDE_CONFIG_DIR"` check was removed in 958397a). `configDir`/
   `configDirEnv` are unused dead parameters, kept on the type since callers
   still pass them. `resolveContextModeDataRoot`/
   `resolveContextModeDataRootOverride` were extracted to
   src/session/data-root.ts (base.ts re-exports them) to break a circular
   import. `CONTEXT_MODE_DIR`/`STORAGE_ROOT_ENV` was left exactly as-is - it
   was never part of the bug (see correction above).
2. Removed the five `getSessionDir()` overrides entirely (codex, opencode,
   vscode-copilot, copilot-cli, kimi) so every adapter inherits
   `BaseAdapter.getSessionDir()`'s global default.
   `getConfigDir()`/`getSettingsPath()` on all five are untouched - platform
   config (`config.toml`, `opencode.json`, `.github/hooks/...`, etc.) still
   lives where the host tool expects it.
3. `npm run build` regenerated hooks/session-db.bundle.mjs; `assert-bundle`
   and `assert-asymmetric-drift` both pass.

Verification for phase 1 (done):
- Regression test (tests/session/global-store.test.ts, describe block
  "hooks path resolves to the same directory as the adapter path") is now
  TABLE-DRIVEN over every adapter with a hook OPTS entry in
  hooks/session-helpers.mjs (claude-code, gemini-cli, antigravity-cli,
  vscode-copilot, copilot-cli, cursor, codex, kiro, kimi,
  jetbrains-copilot): for each, asserts
  `resolveSessionStorageDir(() => resolveDefaultSessionDir(...))` (the hooks
  path) equals `adapter.getSessionDir()` (the server path). Also includes an
  explicit vscode-copilot case with a `.github` directory present in cwd -
  the one case that diverged for real. Confirmed via `git stash` of the src
  changes that this specific case (and 6 of the other 9 table rows) fail
  against commit 0256052 and pass after 958397a.
- Full test suite (`npm test`) matches the pre-change baseline exactly: same
  6 failed files / 9 failed tests, same test names (all pre-existing,
  unrelated to storage-root resolution - Windows symlink EPERM in self-heal
  fixtures, a temp-dir EBUSY/flaky assertion, and a fork-versioning drift in
  tests/scripts/version-sync.test.ts already tracked separately). No test
  that passed before regressed. ~20 adapter/hook tests that asserted
  per-platform roots were rewritten to assert the shared global root, since
  asserting the old behavior is exactly what this fix removes.

All profile/platform-scoped stores are now frozen for every provider. The
migration (phase 2) can be done at leisure with no moving target.

### Phase 2 - migrate the data

A one-off script under scripts/, NOT a new CLI subcommand. The CLI dispatch
(src/cli.ts:191-224) currently exposes index, search, doctor, upgrade, hook,
statusline; adding a permanent `migrate` verb for a one-time operation is
surface area we would then own forever. Promote it to a CLI command only if
this fork is published for others to upgrade.

NEW REQUIREMENT (found during phase 1; the two-level gap below was FIXED as
part of the code-review fixup round, the rest is still open for phase 2):
`adoptLargestLegacyDb` (src/db-base.ts) used to only scan DIRECT dotfile
children of `homedir()` - `readdirSync(home)` filtered to entries starting
with `.`, then `join(home, entry, "context-mode", subdir, fileName)`. That
missed several of the now-frozen platform-rooted stores this plan needs to
migrate:
- FIXED: opencode's/kilo's/zed's old stores were nested two levels deep,
  `~/.config/opencode/context-mode/<subdir>/<hash>.db` (or `.config/kilo`,
  `.config/zed`), and jetbrains-copilot's the same at
  `~/.config/JetBrains/context-mode/<subdir>/<hash>.db` - the one-level scan
  checked `~/.config/context-mode/...` (wrong path, missing the extra
  segment) and never found them. `adoptLargestLegacyDb` now ADDITIONALLY
  checks the two-level entries in `LEGACY_ADAPTER_HOME_SEGMENTS`
  (src/session/data-root.ts, shared with `enumerateAdapterDirs` so the two
  lists can't drift apart) alongside the original one-level dotfile scan.
  The one-level scan was kept, not replaced, specifically because it is
  generic (matches ANY dotfile name) and is the only thing that catches
  arbitrary user-chosen `CLAUDE_CONFIG_DIR` profile names
  (`~/.claude-ime`, `~/.claude-devcom`, `~/.claude-personal`,
  `~/.claude-observix`, ...) - replacing it with a fixed adapter-name list
  (as first attempted) silently broke exactly this case, caught by the
  existing `adoptLargestLegacyDb` test suite.
- STILL OPEN (deferred to phase 2 - out of reach for a homedir-based
  scanner, or too large a change for a contained fix): vscode-copilot's old
  store was project-relative, `<project>/.github/context-mode/<subdir>/
  <hash>.db` when a `.github` dir existed in cwd - never under `homedir()`
  at all, and `adoptLargestLegacyDb` has no project-dir parameter, so no
  homedir-rooted scan can find it regardless of nesting.
- STILL OPEN (deferred to phase 2): any platform whose config-dir env var
  (`CODEX_HOME`, `KIMI_CODE_HOME`, `COPILOT_HOME`, `GEMINI_CLI_HOME`, ...)
  pointed the OLD store outside `homedir()` - the scan has no env-var
  awareness at all, and adding it would require pulling each adapter's own
  config-dir resolver (and its transitive imports) into src/db-base.ts,
  which is more than a contained change to candidate enumeration.
The phase 2 script must enumerate the two STILL OPEN cases above explicitly
(walk each adapter's OLD getConfigDir()-based path and vscode-copilot's
per-project `.github` path) rather than relying on `adoptLargestLegacyDb`.

Behaviour:
1. Enumerate every `<hash>.db` under `sessions/` and `content/` across all
   profile roots and the global root, INCLUDING the platform-rooted stores
   above that `adoptLargestLegacyDb`'s scan cannot reach.
2. For each hash, merge ALL sources into the global copy using one code
   path. Single-source hashes are the trivial case of the same path - no
   special-casing, and it avoids relying on `adoptLargestLegacyDb`'s
   largest-wins behaviour, which silently discards the other copies when a
   hash exists in three or more stores.
3. Merge per the table strategies above. Read-and-replay for content DBs.
4. Dry-run mode first, reporting per-hash row deltas. Default to dry-run.
5. Write to a NEW global DB per project and swap on success, so a failed
   merge cannot corrupt the live store.

Verification for phase 2:
- Post-merge row counts >= max of all input copies, per table, per project.
- Spot-check that the 835 content chunks previously unique to
  content/cc85b9c1aa263b44.db in a profile store are present in global.
- `ctx_search` returns hits that previously existed only in a profile store.
- Spot-check that the opencode/kilo, jetbrains-copilot, and vscode-copilot
  (project-relative `.github`) stores specifically were found and merged,
  since those are exactly the stores `adoptLargestLegacyDb`'s scan misses.

### Phase 3 - correct the broken invariant

src/session/analytics.ts:1599-1602 documents `adoptLargestLegacyDb`'s
contract as "the global copy is a strict superset of any legacy one" and
relies on it to exclude legacy files from aggregate stats without
double-counting. That invariant is already false in the wild (global 1739
events vs personal 2503 for fd02e10d0bf808e8). Once phase 2 makes it true,
either re-assert it with a test or rewrite the comment and the logic to stop
depending on it.

### Phase 4 - decommission

Only after phase 2 verification passes:
- Decide the fate of `adoptLargestLegacyDb` (src/db-base.ts:746-805). Its
  largest-wins copy is lossy and its `existsSync` gate (db-base.ts:755) is
  what made the divergence invisible. Options: delete it, or keep it for
  fresh installs and make it merge rather than copy.
- Only then delete C:\Projects\_store-backup-20260818 and the profile-scoped
  store directories.

## Open decisions

1. Fate of `adoptLargestLegacyDb` (phase 4). Not decided.
2. Whether to keep profile store dirs on disk after a verified merge, or
   delete them. Recommend keeping until at least one full working week
   post-merge.
3. Whether this becomes a published CLI command or stays a one-off script.

## Do not

- Phase 1 DID point every provider's hooks at the global resolver, ahead of
  phase 2 (explicit user scope decision, 2026-08-20 - the functional-parity
  and #649 rationale above outweighed waiting). That means the risk this
  bullet originally warned about is now LIVE, not hypothetical: the global
  DBs already exist for most projects, so `adoptLargestLegacyDb` will not
  fire (`if (existsSync(newDbPath)) return false;`, src/db-base.ts:755), and
  every platform-scoped store frozen by phase 1 - including the ones
  `adoptLargestLegacyDb`'s scan can never reach (see phase 2's NEW
  REQUIREMENT above: opencode, jetbrains-copilot, vscode-copilot,
  env-var-relocated stores) - is stranded until phase 2 runs. Do not treat
  phase 2 as optional or low-priority because of this.
- Do not byte-merge FTS5 tables.
- Do not delete C:\Projects\_store-backup-20260818 before phase 2
  verification.
