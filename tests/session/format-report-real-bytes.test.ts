/**
 * format-report-real-bytes — Phase 8.2-8.4 of D2 PRD
 *
 * Verifies the renderer takes the new `realBytes` opt and uses it to
 * compute conversation + lifetime KEPT TOKENS instead of the conservative
 * `events × 256` token estimate. Net-savings rework dropped the dollar
 * conversion that used to sit on top of this (a /4 guess priced at a
 * hardcoded rate) -- the section-4 line now reports bytes + a labeled
 * token estimate, no $.
 *
 * Backward-compat: when `opts.realBytes` is omitted, the token math is
 * IDENTICAL to the prior version (the Cycle 4 conversation-layout
 * test in stats-output-format.test.ts pins the old token-estimate output).
 */

import { describe, expect, test } from "vitest";
import { formatReport } from "../../src/session/analytics.js";
import type {
  ConversationStats,
  FullReport,
  LifetimeStats,
  RealBytesStats,
} from "../../src/session/analytics.js";

function baseReport(): FullReport {
  return {
    savings: {
      processed_kb: 0,
      entered_kb: 0,
      saved_kb: 0,
      pct: 0,
      savings_ratio: 0,
      by_tool: [],
      total_calls: 0,
      total_bytes_returned: 0,
      kept_out: 0,
      total_processed: 0,
    },
    session: { id: "sess-x", uptime_min: "3.0" },
    continuity: { total_events: 0, by_category: [], compact_count: 0, resume_ready: false },
    projectMemory: {
      total_events: 160,
      session_count: 40,
      by_category: [
        { category: "file", count: 391, label: "Files tracked" },
        { category: "cwd",  count: 173, label: "Working directory" },
      ],
    },
  };
}

function baseConversation(): ConversationStats {
  return {
    sessionId: "b5833e08-test",
    events: 1277,
    dbCount: 2,
    daysAlive: 11.4,
    snapshotBytes: 1552 * 1024,
    snapshotsConsumed: 1,
    byCategory: [{ category: "file", count: 131, label: "Files tracked" }],
  };
}

function baseLifetime(): LifetimeStats {
  return {
    totalEvents: 16_366,
    totalSessions: 411,
    autoMemoryCount: 22,
    autoMemoryProjects: 6,
    autoMemoryByPrefix: { project: 11 },
    categoryCounts: { file: 5082 },
    rescueBytes: 1675 * 1024,
    firstEventMs: Date.parse("2026-04-14T00:00:00Z"),
    distinctProjects: 10,
  };
}

/**
 * Helper: extract the lifetime kept-token estimate from the section-4
 * line so the assertion can compare numerically instead of regex-matching
 * every variant of the formatted figure. Section 4 — "The bottom line" —
 * reports bytes + a labeled token estimate, no dollar figure.
 */
function extractLifetimeKeptTokens(text: string): number {
  const m = text.match(/~([\d.]+)([KM]?) tokens est\. your team didn't re-read/);
  if (!m) throw new Error(`section-4 kept-tokens line not found in:\n${text}`);
  const n = parseFloat(m[1]);
  if (m[2] === "M") return n * 1_000_000;
  if (m[2] === "K") return n * 1_000;
  return n;
}

/**
 * Pin the locale/tz/cwd/now opts on every formatReport call so the
 * narrative renderer's section-1 datetime + section-3 receipt strings
 * are byte-stable across CI machines. Without these, ambient
 * process.cwd() / Date.now() / Intl detection would leak into output.
 */
const STABLE_OPTS = {
  cwd:    "/home/u/cm",
  now:    Date.UTC(2026, 4, 10, 18, 0, 0),
  locale: "en-TR" as const,
  tz:     "Europe/Istanbul" as const,
};

describe("formatReport — Phase 8 realBytes opt", () => {
  test("8.4 backward compat: omitting realBytes still emits the legacy events×256 token estimate", () => {
    const text = formatReport(baseReport(), "1.0.111", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      ...STABLE_OPTS,
    });
    // Conservative estimate: 16,366 lifetime events × 256 ≈ 4.2M tokens.
    // The narrative renderer surfaces this via section 4's bottom-line.
    expect(text).toMatch(/~[\d.]+M tokens est\. your team didn't re-read/);
    expect(text).not.toMatch(/\$/);
  });

  test("8.2 realBytes measurement is authoritative for the lifetime kept-token estimate", () => {
    // Honest-savings fix: measured redirects REPLACE the events×256
    // heuristic instead of Math.max-ing with it — capture volume
    // (eventDataBytes, snapshotBytes) is not savings.
    const realBytes: RealBytesStats = {
      eventDataBytes: 80_000_000,   // 80 MB of indexed event data (not savings)
      bytesAvoided:  120_000_000,   // 120 MB sandbox / cache avoided
      bytesReturned:   2_000_000,   // 2 MB returned to model
      snapshotBytes:   8_000_000,   // 8 MB rescued from compact (not savings)
      totalSavedTokens: Math.floor(120_000_000 / 4),
    };

    const text = formatReport(baseReport(), "1.0.111", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { lifetime: realBytes },
      ...STABLE_OPTS,
    });
    const keptTokens = extractLifetimeKeptTokens(text);
    // kept tokens = (avoided + returned)/4 − returned/4 = 30M exactly —
    // derived ONLY from measured redirects (eventData/snapshot excluded).
    // The legacy events×256 heuristic would have produced ~4.2M instead.
    expect(keptTokens).toBeCloseTo(30_000_000, -5);
  });

  test("8.2 realBytes also drives the conversation contribution token estimate", () => {
    const lifetimeRealBytes: RealBytesStats = {
      eventDataBytes: 80_000_000,
      bytesAvoided:  120_000_000,
      bytesReturned:   2_000_000,
      snapshotBytes:   8_000_000,
      totalSavedTokens: Math.floor((80_000_000 + 120_000_000 + 8_000_000) / 4),
    };
    const conversationRealBytes: RealBytesStats = {
      eventDataBytes: 4_000_000,    // 4 MB this conversation
      bytesAvoided:   6_000_000,    // 6 MB
      bytesReturned:    100_000,
      snapshotBytes:  1_552 * 1024, // matches conversation.snapshotBytes
      totalSavedTokens: Math.floor((4_000_000 + 6_000_000 + 1_552 * 1024) / 4),
    };

    const text = formatReport(baseReport(), "1.0.111", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { lifetime: lifetimeRealBytes, conversation: conversationRealBytes },
      ...STABLE_OPTS,
    });

    // Conversation token count appears in the section-1 Without/With
    // bars (e.g. "2.9M tokens"). Real bytes ~2.9M tok (vs conservative 81K).
    const receiptLine = text.split("\n").find((l) =>
      l.includes("Without context-mode") && /tokens/.test(l)
    );
    expect(receiptLine).toBeTruthy();
    expect(receiptLine!).toMatch(/[\d.]+M tokens/);
  });

  test("8.3 load-bearing narrative strings stay intact when realBytes is on", () => {
    const realBytes: RealBytesStats = {
      eventDataBytes: 80_000_000,
      bytesAvoided:  120_000_000,
      bytesReturned:   2_000_000,
      snapshotBytes:   8_000_000,
      totalSavedTokens: 52_000_000,
    };

    const text = formatReport(baseReport(), "1.0.111", null, {
      conversation: baseConversation(),
      lifetime: baseLifetime(),
      realBytes: { lifetime: realBytes },
      ...STABLE_OPTS,
    });

    // 5-section narrative load-bearing strings — only the underlying $
    // math changes when realBytes is on; the structure is invariant.
    expect(text).toMatch(/─── 1\. Where you are now ───/);
    expect(text).toMatch(/─── 3\. The scope, getting wider ───/);
    expect(text).toMatch(/This conversation/);
    expect(text).toMatch(/days alive · still going/);
    expect(text).toMatch(/\/compact fired — 1552 KB rescued from snapshot/);
    expect(text).toMatch(/All your work:/);
    expect(text).toMatch(/Your AI talks less, remembers more, costs less/);
  });
});
