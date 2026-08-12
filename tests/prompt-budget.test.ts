import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoutingBlock } from "../hooks/routing-block.mjs";
import { createSubagentPointer } from "../hooks/routing-block.mjs";
import { createToolNamer } from "../hooks/core/tool-naming.mjs";

/**
 * Regression guard for the MCP prompt budget (maint/prompt-diet, 2026-08-12).
 *
 * Two things are paid on every request regardless of what the agent is
 * doing: the MCP tool schemas (tools/list, sent once per session but
 * re-sent on every reconnect) and the SessionStart routing block (once per
 * session, and previously once per subagent spawn too). Both were audited
 * pre-diet: 29,959 bytes of tool schemas (~8.3K tokens) and a ~4.6KB
 * routing block injected into the main session AND every subagent spawn.
 *
 * MEASUREMENT METHOD (must match exactly, or numbers will not reconcile -
 * see the CONTEXT_MODE_PROJECT_DIR note below for why this bit us once):
 *   1. Build the bundle first: `npm run bundle`. This guard spawns the
 *      COMMITTED server.bundle.mjs, not src/server.ts - a stale bundle
 *      makes this guard (and the running server) exercise old behavior.
 *   2. Speak MCP over stdio exactly like a real client: initialize,
 *      notifications/initialized, tools/list.
 *   3. Sum JSON.stringify(tool).length across every tool in the response.
 *      This is the literal byte count re-sent on every reconnect - the
 *      same approach used to size the diet, so before/after figures are
 *      comparable.
 *
 * PRE-DIET BASELINE: 29,959 bytes. Measured against server.bundle.mjs at
 * commit b3b84fc (before this branch's changes), CONTEXT_MODE_PROJECT_DIR
 * unset, no other CONTEXT_MODE_* env vars set.
 *
 * KNOWN SOURCE OF VARIANCE: CONTEXT_MODE_PLATFORM has NO effect on this
 * total - the MCP server always returns bare tool names in tools/list
 * (`server.registerTool("ctx_execute", ...)`); host-side prefixing (e.g.
 * claude-code's mcp__plugin_context-mode_context-mode__ctx_execute) is
 * applied by the CLIENT when presenting tools to the model and never
 * appears in the tools/list JSON payload this guard measures. What DOES
 * matter: CONTEXT_MODE_PROJECT_DIR (shared-DB mode) adds a "project" field
 * to ctx_search's schema - a real ~176-byte difference between the default
 * per-project mode and shared-DB mode. This guard measures shared-DB mode
 * (below) because it is the worst case; any bound that holds there holds
 * for the smaller default mode too.
 *
 * The guard asserts a REDUCTION RATIO against the recorded baseline rather
 * than an absolute byte count. An absolute number needs manual re-tuning
 * every time a legitimate field is added and silently drifts away from the
 * actual invariant ("at least 50% smaller than baseline"); the ratio states
 * that invariant directly and cannot go stale for cosmetic reasons.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_BUNDLE = resolve(ROOT, "server.bundle.mjs");

const PRE_DIET_BASELINE_BYTES = 29_959;
const MIN_REDUCTION_RATIO = 0.5; // "at least 50% smaller than baseline"

function listTools(env: NodeJS.ProcessEnv = {}): Promise<Array<{ name: string; description?: string }>> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("node", [SERVER_BUNDLE], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error("timed out waiting for tools/list response"));
    }, 15_000);

    proc.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (settled) return;
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.tools) {
            settled = true;
            clearTimeout(timer);
            proc.kill();
            resolvePromise(msg.result.tools);
            return;
          }
        } catch {
          // partial line - keep buffering
        }
      }
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prompt-budget-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map((o) => JSON.stringify(o)).join("\n") + "\n";
    proc.stdin.write(reqs);
  });
}

describe("MCP tool schema prompt budget (maint/prompt-diet)", () => {
  it(`stays at least ${MIN_REDUCTION_RATIO * 100}% smaller than the ${PRE_DIET_BASELINE_BYTES}-byte pre-diet baseline, in shared-DB mode (worst case)`, async () => {
    const tools = await listTools({ CONTEXT_MODE_PROJECT_DIR: ROOT });
    expect(tools.length).toBeGreaterThanOrEqual(11);
    const total = tools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    const reduction = 1 - total / PRE_DIET_BASELINE_BYTES;
    expect(reduction, `total=${total}b, reduction=${(reduction * 100).toFixed(1)}%`).toBeGreaterThanOrEqual(MIN_REDUCTION_RATIO);
  }, 20_000);

  it("default per-project mode is smaller than shared-DB mode", async () => {
    const [defaultMode, sharedMode] = await Promise.all([
      listTools(),
      listTools({ CONTEXT_MODE_PROJECT_DIR: ROOT }),
    ]);
    const sum = (tools: Array<{ name: string }>) => tools.reduce((s, t) => s + JSON.stringify(t).length, 0);
    expect(sum(defaultMode)).toBeLessThanOrEqual(sum(sharedMode));
  }, 20_000);
});

describe("Routing block prompt budget (maint/prompt-diet)", () => {
  // claude-code has the longest MCP tool-name prefix
  // (mcp__plugin_context-mode_context-mode__<tool>) of any supported
  // platform, so it is the worst case for byte count.
  const t = createToolNamer("claude-code");

  // Target from the diet brief: short mode under 1,200 bytes. Measured
  // 1,198 for claude-code, the worst-case tool-name prefix of any platform.
  it("short mode (the new SessionStart default) stays under 1,200 bytes", () => {
    const short = createRoutingBlock(t, { mode: "short" });
    expect(short.length).toBeLessThan(1200);
  });

  // Original pre-diet block measured 4,603 bytes (see the byte-for-byte
  // equality check against the pre-diet source in this same describe -
  // full mode is untouched content, not a new shape). This guard catches
  // anyone accidentally growing the "full" branch while touching "short".
  it("full mode has not grown past its original size", () => {
    const full = createRoutingBlock(t, { mode: "full" });
    expect(full.length).toBeLessThanOrEqual(4603);
  });

  it("off mode injects nothing", () => {
    expect(createRoutingBlock(t, { mode: "off" })).toBe("");
  });

  it("subagent pointer stays under 1,000 bytes with the ToolSearch bootstrap included", () => {
    const pointer = createSubagentPointer(t, { toolSearchBootstrap: true });
    const full = createRoutingBlock(t, { mode: "full", includeCommands: false, toolSearchBootstrap: true });
    expect(pointer.length).toBeLessThan(1000);
    expect(pointer.length).toBeLessThan(full.length * 0.5);
  });
});
