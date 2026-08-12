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
 * every tool — the same measurement approach used to size the diet. It
 * fails if descriptions get re-inflated past the budget.
 */

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SERVER_BUNDLE = resolve(ROOT, "server.bundle.mjs");

// Pre-diet baseline was 29,959 bytes. The diet landed at 14,959 — comfortably
// under half. The threshold leaves headroom for legitimate future growth
// (a new field, a clarifying sentence) without permitting the regression
// back toward the old total.
const TOOL_SCHEMA_BUDGET = 16_000;

function listTools(): Promise<Array<{ name: string; description?: string }>> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("node", [SERVER_BUNDLE], { stdio: ["pipe", "pipe", "pipe"] });
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
          // partial line — keep buffering
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
  it(`total tools/list payload stays under ${TOOL_SCHEMA_BUDGET} bytes`, async () => {
    const tools = await listTools();
    expect(tools.length).toBeGreaterThanOrEqual(11);
    const total = tools.reduce((sum, t) => sum + JSON.stringify(t).length, 0);
    expect(total).toBeLessThan(TOOL_SCHEMA_BUDGET);
  }, 20_000);
});

describe("Routing block prompt budget (maint/prompt-diet)", () => {
  // claude-code has the longest MCP tool-name prefix
  // (mcp__plugin_context-mode_context-mode__<tool>) of any supported
  // platform, so it is the worst case for byte count.
  const t = createToolNamer("claude-code");

  it("short mode (the new SessionStart default) stays well under the old full-block size", () => {
    const short = createRoutingBlock(t, { mode: "short" });
    const full = createRoutingBlock(t, { mode: "full" });
    expect(short.length).toBeLessThan(2000);
    expect(short.length).toBeLessThan(full.length * 0.5);
  });

  it("off mode injects nothing", () => {
    expect(createRoutingBlock(t, { mode: "off" })).toBe("");
  });

  it("subagent pointer is far cheaper than the full block that used to be injected per-spawn", () => {
    const pointer = createSubagentPointer(t, { toolSearchBootstrap: true });
    const full = createRoutingBlock(t, { mode: "full", includeCommands: false, toolSearchBootstrap: true });
    expect(pointer.length).toBeLessThan(2000);
    expect(pointer.length).toBeLessThan(full.length * 0.5);
  });
});
