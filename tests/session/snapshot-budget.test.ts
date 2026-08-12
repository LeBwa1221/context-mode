import { describe, it, expect } from "vitest";
import { buildResumeSnapshot, type StoredEvent } from "../../src/session/snapshot.js";

/**
 * Regression guard for the resume snapshot's byte budget.
 *
 * The snapshot is injected through a hook. Claude Code caps that payload at
 * 10,000 characters and silently replaces anything larger with a file path
 * plus a preview, so an over-budget snapshot loses everything rather than its
 * tail — and reports no error while doing it. Before this guard, a real
 * 866-event session produced 643,930 bytes.
 */

function ev(category: string, data: string, type = category): StoredEvent {
  return { type, category, data, priority: 1 };
}

/** A session big enough to blow an unbounded builder wide open. */
function hugeSession(): StoredEvent[] {
  const events: StoredEvent[] = [];
  const filler = "x".repeat(4000);
  for (let i = 0; i < 200; i++) {
    events.push(ev("subagent", `agent ${i} transcript ${filler}`, "subagent_completed"));
    events.push(ev("error", `error ${i} ${filler}`));
    events.push(ev("decision", `decision ${i} ${filler}`));
    events.push(ev("git", `commit ${i} ${filler}`));
    events.push(ev("rule", `rule ${i} ${filler}`, "rule_content"));
  }
  return events;
}

describe("resume snapshot budget", () => {
  it("stays within the default budget on a large session", () => {
    const snap = buildResumeSnapshot(hugeSession());
    expect(snap.length).toBeLessThanOrEqual(8000);
  });

  it("stays under the host's 10,000-character injected-context cap", () => {
    const snap = buildResumeSnapshot(hugeSession());
    expect(snap.length).toBeLessThan(10000);
  });

  it("honors an explicit maxBytes instead of ignoring it", () => {
    const snap = buildResumeSnapshot(hugeSession(), { maxBytes: 3000 });
    expect(snap.length).toBeLessThanOrEqual(3000);
  });

  it("keeps the goal, pending tasks, and latest user message even when over budget", () => {
    const events = [
      ...hugeSession(),
      ev("goal", "ship the resume budget fix"),
      ev("task", JSON.stringify({ subject: "land the budget guard" }), "TaskCreate"),
      ev("user-prompt", "what is left to do?"),
    ];
    const snap = buildResumeSnapshot(events);

    expect(snap).toContain("ship the resume budget fix");
    expect(snap).toContain("land the budget guard");
    expect(snap).toContain("what is left to do?");
    expect(snap.length).toBeLessThanOrEqual(8000);
  });

  it("says so when it drops lower-priority sections", () => {
    const snap = buildResumeSnapshot(hugeSession());
    expect(snap).toContain("<elided");
  });

  it("still emits a search call so elided detail stays reachable", () => {
    const snap = buildResumeSnapshot(hugeSession(), { searchTool: "ctx_search" });
    expect(snap).toContain("ctx_search(");
  });

  it("leaves a small session untouched by the budget", () => {
    const snap = buildResumeSnapshot([
      ev("goal", "small session"),
      ev("error", "one failure"),
    ]);
    expect(snap).toContain("one failure");
    expect(snap).not.toContain("<elided");
  });
});
