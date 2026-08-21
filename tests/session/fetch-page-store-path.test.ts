/**
 * fetch-page-store-path — regression guard for getPageStore()'s resolved
 * location.
 *
 * getPageStore() MUST resolve its "fetch-pages.db" file beside getStorePath()
 * (the same directory the content FTS5 DB lives in), which in turn resolves
 * under resolveContextModeDataRoot()'s unified tree. Before HANDOFF.md items
 * 6-7, storage resolved relative to the active host profile's own config dir
 * (~/.claude, ~/.claude-ime, ...), so the SAME project got a separate,
 * divergent store per profile. This test fails if getPageStore() is ever
 * refactored to resolve from a config/profile dir instead of delegating to
 * getStorePath() — the exact regression global-store.test.ts guards for the
 * content DB, extended to the page store.
 */
import "../setup-home";
import { fakeHome } from "../setup-home";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveContextModeDataRoot } from "../../src/adapters/base.js";
import { getPageStore, getStorePath } from "../../src/server.js";

afterEach(() => {
  delete process.env.CONTEXT_MODE_HOME;
  delete process.env.CONTEXT_MODE_DATA_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("getPageStore() resolves under the unified global store root", () => {
  it("creates fetch-pages.db beside getStorePath(), under resolveContextModeDataRoot()'s tree", () => {
    getPageStore();

    // Same computation getPageStore() itself performs internally
    // (join(dirname(getStorePath()), "fetch-pages.db")). If getPageStore()
    // were ever changed to resolve from a different root (e.g. a
    // profile/config dir), the file it actually creates would land
    // somewhere else and this assertion would fail.
    const expectedPath = join(dirname(getStorePath()), "fetch-pages.db");
    expect(existsSync(expectedPath)).toBe(true);

    const root = resolveContextModeDataRoot();
    expect(expectedPath.startsWith(root)).toBe(true);
    expect(expectedPath.startsWith(fakeHome)).toBe(true);
    // The multi-profile bug this whole tree of fixes replaces: storage
    // resolving relative to a profile's own config dir instead of the
    // shared global root.
    expect(expectedPath).not.toContain(".claude");
  });
});
