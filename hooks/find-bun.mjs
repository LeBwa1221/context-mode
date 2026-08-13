// Resolve a bun binary from the known install locations and $PATH.
// Raw JS (not runtime.ts) so start.mjs can use it before build/ exists.
// Pure/injectable for tests.
//
// Ported from upstream PRs #973 ("allow resolve bun from $PATH") and #972
// ("do not hardcode bash location"), which landed on maint/upstream-picks -
// bringing that self-contained pair into this branch without pulling in the
// rest of that branch's changes.
import { win32, posix } from "node:path";
import { existsSync as realExistsSync } from "node:fs";
import { homedir as realHomedir } from "node:os";

export function findBun({
  env = process.env,
  platform = process.platform,
  home = realHomedir(),
  existsSync = realExistsSync,
} = {}) {
  const exe = platform === "win32" ? "bun.exe" : "bun";
  const delimiter = platform === "win32" ? ";" : ":";
  // Join with the path style matching `platform`, not the host OS running this
  // code - findBun("linux") must still return posix paths when run on Windows
  // (its only real caller is start.mjs's Linux-only Bun re-exec, but tests and
  // Windows CI exercise every `platform` value against the host's node:path).
  const { join } = platform === "win32" ? win32 : posix;
  const candidates = [
    env.BUN_INSTALL ? join(env.BUN_INSTALL, "bin", exe) : null,
    home ? join(home, ".bun", "bin", exe) : null,
    join("/usr/local/bin", exe),
    join("/usr/bin", exe),
    ...(env.PATH || "").split(delimiter).filter(Boolean).map((dir) => join(dir, exe)),
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}
