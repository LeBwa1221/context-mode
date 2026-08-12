/**
 * Slice 3 — `renderCostExample` helper
 *
 * Section 4 of the 5-section narrative ("What that adds up to"). Used to
 * translate lifetime tokens into a dollar figure at a hardcoded per-token
 * rate. Net-savings rework dropped that entirely: a dollar figure derived
 * from an unmeasured /4 token guess, priced at a hardcoded rate, was three
 * assumptions deep and got read as fact. This now reports bytes (measured)
 * and a labeled token estimate only -- no dollar sign anywhere.
 *
 * Contract: pure (lifetimeBytes, lifetimeTokens, lifetimeDays) -> string[]
 * with no IO. The byte -> MB format matches `kb()` already defined in
 * analytics.ts.
 */

import { describe, expect, test } from "vitest";
import { renderCostExample } from "../../src/session/analytics.js";

describe("renderCostExample", () => {
  const LIFETIME_BYTES  = 356 * 1024 * 1024;
  const LIFETIME_TOKENS = 93_315_333;
  const LIFETIME_DAYS   = 67;

  test("emits the headline byte/token tally with no dollar sign", () => {
    const text = renderCostExample(LIFETIME_BYTES, LIFETIME_TOKENS, LIFETIME_DAYS).join("\n");
    expect(text).toMatch(/356 MB kept out of context, lifetime/);
    expect(text).toMatch(/93\.3M tokens est\./);
    expect(text).not.toMatch(/\$/);
  });

  test("labels the token figure as an estimate, not a measurement", () => {
    const text = renderCostExample(LIFETIME_BYTES, LIFETIME_TOKENS, LIFETIME_DAYS).join("\n");
    expect(text).toMatch(/estimate/i);
  });

  test("returns [] when lifetime tokens is zero", () => {
    expect(renderCostExample(0, 0, 0)).toEqual([]);
  });
});
