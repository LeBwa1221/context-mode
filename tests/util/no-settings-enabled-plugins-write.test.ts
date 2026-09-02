import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard: the MCP boot path and the npm postinstall path must never
// write `enabledPlugins` into a user's settings.json. The old
// `healSettingsEnabledPlugins` did exactly that, and because the fork's
// marketplace key drifted it kept re-enabling a plugin key that resolved to
// nothing. A plugin re-enabling itself in user config is the bug; the stale key
// only made it visible.

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

describe("no settings.json enabledPlugins write on the boot path", () => {
  it("the shared heal module exports no settings.json heal", async () => {
    const heal = await import("../../scripts/heal-installed-plugins.mjs");
    expect(Object.keys(heal).filter((k) => /settings/i.test(k))).toEqual([]);
  });

  for (const rel of ["scripts/heal-installed-plugins.mjs", "scripts/postinstall.mjs"]) {
    it(`${rel} never touches settings.json`, () => {
      // Ban the filename, not the bare word: `/settings/i` also tripped on any
      // identifier or prose containing "settings", which is not the bug class.
      expect(readFileSync(resolve(ROOT, rel), "utf-8")).not.toMatch(/settings\.json/i);
    });
  }

  it("start.mjs never assigns into an enabledPlugins map", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    // start.mjs does write settings.json for SessionStart hook registration
    // (Layer 4), so only the enabledPlugins assignment is banned here.
    expect(src).not.toMatch(/enabledPlugins\s*(\[[^\]]*\])?\s*=[^=]/);
  });
});
