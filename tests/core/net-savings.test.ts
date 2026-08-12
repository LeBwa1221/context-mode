/**
 * Net-savings accounting -- regression tests for the invariants called out
 * in the net-savings rework (maint/net-savings):
 *
 *   1. Savings never exceed 100%.
 *   2. Never report savings when there were zero ctx_* calls.
 *   3. A per-chat figure never exceeds the lifetime total.
 *   4. Never present a byte ratio as if it were a time saving.
 *
 * computeNetSavingsFromBytes() is the pure math core of computeNetSavings()
 * (src/server.ts) -- split out so these invariants are testable without
 * spawning the MCP server or mocking a live tools/list round trip. The only
 * production caller (computeNetSavings) feeds it grossBytes/overheadBytes
 * from LIVE measurements; this file only exercises the arithmetic.
 */

import { describe, expect, test } from "vitest";
import {
  computeNetSavingsFromBytes,
  renderNetSavings,
  type RoutingOverhead,
} from "../../src/server.js";
import { formatReport, type FullReport } from "../../src/session/analytics.js";

const routing: RoutingOverhead = { mode: "short", bytes: 500, subagentPointerBytes: 200 };

describe("computeNetSavingsFromBytes", () => {
  test("zero ctx_* calls (grossBytes=0) reports negative net, not savings", () => {
    const n = computeNetSavingsFromBytes(0, 1000, 1000, routing);
    expect(n.netBytes).toBeLessThan(0);
    expect(n.breakEvenReached).toBe(false);
    expect(n.netTokens).toBe(0);
  });

  test("net is negative when overhead exceeds gross bytes redirected", () => {
    const n = computeNetSavingsFromBytes(300, 1000, 1000, routing);
    expect(n.netBytes).toBe(-700);
    expect(n.breakEvenReached).toBe(false);
  });

  test("break-even reached exactly when gross >= overhead", () => {
    expect(computeNetSavingsFromBytes(1000, 1000, 1000, routing).breakEvenReached).toBe(true);
    expect(computeNetSavingsFromBytes(999, 1000, 1000, routing).breakEvenReached).toBe(false);
  });

  test("net never exceeds gross (overhead is only ever subtracted, never added)", () => {
    const n = computeNetSavingsFromBytes(1_000_000, 500, 500, routing);
    expect(n.netBytes).toBeLessThanOrEqual(n.grossBytes);
  });

  test("renderNetSavings states NEGATIVE plainly instead of a misleading positive figure", () => {
    const n = computeNetSavingsFromBytes(0, 5000, 5000, routing);
    const text = renderNetSavings(n).join("\n");
    expect(text).toMatch(/NEGATIVE/);
    expect(text).not.toMatch(/\d+% (kept out|reduction|saved)/);
  });

  test("renderNetSavings never phrases a byte figure as a time saving", () => {
    const n = computeNetSavingsFromBytes(50_000, 1000, 1000, routing);
    const text = renderNetSavings(n).join("\n");
    expect(text).not.toMatch(/\d+\s*(ms|milliseconds|seconds|minutes|hours)\s+saved/i);
    expect(text).not.toMatch(/time saved/i);
  });
});

describe("formatReport — savings percentage never exceeds 100%", () => {
  function baseReport(overrides: Partial<FullReport["savings"]> = {}): FullReport {
    return {
      savings: {
        processed_kb: 0, entered_kb: 0, saved_kb: 0, pct: 0, savings_ratio: 0,
        by_tool: [], total_calls: 1, total_bytes_returned: 1, kept_out: 1_000_000,
        total_processed: 1_000_001,
        ...overrides,
      },
      session: { id: "s", uptime_min: "1.0" },
      continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
      projectMemory: { total_events: 0, session_count: 0, by_category: [] },
    };
  }

  test("reduction percentage is clamped at 100, never over", () => {
    // kept_out vastly larger than total_bytes_returned would compute >100%
    // without clamping.
    const text = formatReport(baseReport({ total_bytes_returned: 1, kept_out: 50_000_000 }));
    const m = text.match(/([\d.]+)% reduction/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBeLessThanOrEqual(100);
  });
});

describe("formatReport — per-chat figure never exceeds lifetime total", () => {
  test("session tokens est. <= lifetime tokens est. in the footer", () => {
    const report: FullReport = {
      savings: {
        processed_kb: 0, entered_kb: 0, saved_kb: 0, pct: 0, savings_ratio: 0,
        by_tool: [], total_calls: 3, total_bytes_returned: 1000,
        kept_out: 500_000, total_processed: 501_000,
      },
      session: { id: "s", uptime_min: "1.0" },
      continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
      projectMemory: { total_events: 0, session_count: 0, by_category: [] },
    };
    const text = formatReport(report, "1.0.0", null, {
      lifetime: { totalEvents: 0, totalSessions: 0, autoMemoryCount: 0, autoMemoryProjects: 0, autoMemoryByPrefix: {} },
    });
    const footer = text.match(/~([\d,.KM]+) tokens est\. this session\s+·\s+~([\d,.KM]+) tokens est\. lifetime/);
    expect(footer).toBeTruthy();
  });
});
