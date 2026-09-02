import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeHooksJson } from "../../hooks/normalize-hooks.mjs";
// @ts-expect-error — JS module, no TS declarations
import { cachePluginPrefix } from "../../hooks/cache-layout.mjs";

// Regression guard for the whole "hardcoded marketplace segment" class.
//
// Claude Code installs plugins at plugins/cache/<marketplace>/<plugin>/<version>.
// Upstream context-mode ships from a marketplace also named "context-mode", so
// the doubled `context-mode/context-mode` literal was correct there and got
// copied into several heal paths. This fork is served from the `dskrypnyk`
// marketplace, where every one of those literals anchors on a directory that
// does not exist: the heal finds nothing and reports success. Derive the
// segment from the running install instead.

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

// Files whose heal logic walks or matches a plugin-cache path.
const GUARDED = [
  "hooks/cache-heal-utils.mjs",
  "hooks/normalize-hooks.mjs",
  "hooks/heal-partial-install.mjs",
  "hooks/sessionstart.mjs",
  "src/cli.ts",
  "src/adapters/claude-code/index.ts",
];

/** Drop block and line comments so prose about the old literal stays legal. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/.*$/gm, "");
}

describe("marketplace cache segment is derived, not hardcoded", () => {
  for (const rel of GUARDED) {
    it(`${rel} has no doubled context-mode path literal in code`, () => {
      const code = stripComments(readFileSync(resolve(ROOT, rel), "utf-8"));
      // Three shapes the doubled literal has actually appeared in:
      //   path text      `context-mode/context-mode`
      //   regex source   `context-mode[/\\]context-mode`
      //   join/resolve   `"context-mode", "context-mode"`
      // The plugin-key form `context-mode@context-mode` is deliberately NOT
      // matched -- that is a registry key, a separate question from the path.
      expect(code).not.toMatch(
        /context-mode(?:[/\\]{1,2}|\[[^\]]{1,8}\])context-mode/,
      );
      expect(code).not.toMatch(/"context-mode"\s*,\s*"context-mode"/);
    });
  }

  it("heals a stale version segment under a non-upstream marketplace", () => {
    const pluginRoot = "/home/u/.claude/plugins/cache/dskrypnyk/context-mode/2.0.1";
    const hooks = JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "node /home/u/.claude/plugins/cache/dskrypnyk/context-mode/1.0.146/hooks/sessionstart.mjs",
              },
            ],
          },
        ],
      },
    });

    const out = normalizeHooksJson(hooks, "/usr/bin/node", pluginRoot);

    expect(out).toContain("dskrypnyk/context-mode/2.0.1/hooks/sessionstart.mjs");
    expect(out).not.toContain("1.0.146");
  });

  it("matches the cache segment case-insensitively on win32 only", () => {
    // A win32 path surfaced as `Plugins\Cache\...` is the same directory. If
    // the segment match misses it, cachePluginPrefix returns null and callers
    // fall back to UPSTREAM_CACHE_PREFIX -- the hardcoded literal again.
    expect(cachePluginPrefix("C:/u/.claude/plugins/cache/dskrypnyk/context-mode/2.0.1"))
      .toBe("dskrypnyk/context-mode");

    const mixed = "C:/u/.claude/Plugins/Cache/dskrypnyk/context-mode/2.0.1";
    expect(cachePluginPrefix(mixed)).toBe(
      process.platform === "win32" ? "dskrypnyk/context-mode" : null,
    );
  });
});
