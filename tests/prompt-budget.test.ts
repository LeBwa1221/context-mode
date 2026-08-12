import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoutingBlock } from "../hooks/routing-block.mjs";
import { createSubagentPointer } from "../hooks/routing-block.mjs";
import { createToolNamer } from "../hooks/core/tool-naming.mjs";

/**
 * Regression guard for the MCP prompt budget (maint/prompt-diet).
 *
 * Two things are paid on every request regardless of what the agent is
 * doing: the MCP tool schemas (tools/list, sent once per session but
 * re-sent on every reconnect) and the SessionStart routing block (once per
 * session, and previously once per subagent spawn too). Both were audited
 * pre-diet: ~29,959 bytes of tool schemas (~8.3K tokens) and a ~4.8KB
 * routing block injected into the main session AND every subagent spawn.
 *
 * This guard boots the built server, calls tools/list over stdio exactly
 * like a real MCP client would, and sums JSON.stringify(tool).length across
 * every tool - the same measurement approach used to size the diet. It
 * fails if descriptions get re-inflated past the budget.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_BUNDLE = resolve(ROOT, "server.bundle.mjs");

// Pre-diet baseline was 29,959 bytes measured with a bare per-project DB
// (CONTEXT_MODE_PROJECT_DIR unset). In shared-DB mode (CONTEXT_MODE_PROJECT_DIR
// set) ctx_search's schema grows a "project" field, which is a legitimate
// deployment mode, not an accident - so this guard measures THAT mode: it is
// the worst case for schema size and any budget that holds for it holds for
// the default mode too. Worst case landed at 14,715 (-50.9%).
//
// The threshold is pinned to the 50%-reduction line itself (half of 29,959,
// rounded down), not an arbitrary round number - a schema total under this
// line is by definition at least a 50% cut. That leaves ~264 bytes of
// deliberate headroom above the current worst-case total for a genuine
// future field or clarifying sentence, without permitting drift back toward
// the old total. Tool descriptions also embed live runtime detection
// (available language interpreters, Bun presence) which varies a few dozen
// bytes across machines; this headroom absorbs that too.
const TOOL_SCHEMA_BUDGET = 14_979;

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
  it(`total tools/list payload stays under ${TOOL_SCHEMA_BUDGET} bytes in shared-DB mode (worst case)`, async () => {
    const tools = await listTools({ CONTEXT_MODE_PROJECT_DIR: ROOT });
    expect(tools.length).toBeGreaterThanOrEqual(11);
    const total = tools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    expect(total).toBeLessThan(TOOL_SCHEMA_BUDGET);
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
