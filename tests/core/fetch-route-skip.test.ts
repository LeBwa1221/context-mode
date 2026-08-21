/**
 * fetch-route-skip — regression guard for `routeSkipsExtraction`'s wiring
 * inside `indexFetched`.
 *
 * `extractAndStore` is a markdown-block splitter/classifier. Its
 * "allTemplate" verdict (every block already seen on another page of the
 * same host) is meaningful for converted HTML, not for JSON or plain-text
 * API responses, which routinely repeat byte-for-byte across calls without
 * that meaning "this is chrome". If `indexFetched` ever ran extraction on a
 * `json`/`text` fetch, a repeated API response could hit the "refuse to
 * index" branch instead of reaching `store.indexJSON`/`indexPlainText` —
 * silently breaking JSON/text indexing. `routeSkipsExtraction` exists
 * specifically to keep those two routes out of extraction entirely; this
 * test proves `indexFetched` actually honours it end to end, not just that
 * the guard function itself returns the right boolean.
 */
import "../setup-home";
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { indexFetched } from "../../src/server.js";

const NAV = "* [Home](/)\n* [Docs](/docs)\n* [Pricing](/pricing)\n";
const FOOTER = "(c) 2026 Example Inc. All rights reserved.\n";
function page(article: string): string {
  return `# Example\n\n${NAV}\n${article}\n${FOOTER}`;
}

describe("indexFetched skips extraction for json/text routes", () => {
  test("a repeated JSON payload from the same host reaches store.indexJSON, never refuses", () => {
    const host = `json-route-${Date.now()}.example.com`;
    const payload = JSON.stringify({ status: "ok", data: [1, 2, 3] });

    const r1 = indexFetched({
      url: `https://${host}/a`, source: `s-json-a-${Date.now()}`,
      markdown: payload, header: "__CM_CT__:json", route: "json",
    });
    assert.equal(r1.refusal, undefined, "json route must never refuse");
    assert.ok(r1.totalChunks > 0, "store.indexJSON must actually index the payload");
    assert.equal(r1.extraction, undefined, "extraction must not run for the json route");

    // Same host, byte-identical body — the exact shape that WOULD be flagged
    // allTemplate if this were routed through extraction as HTML.
    const r2 = indexFetched({
      url: `https://${host}/b`, source: `s-json-b-${Date.now()}`,
      markdown: payload, header: "__CM_CT__:json", route: "json",
    });
    assert.equal(r2.refusal, undefined, "json route must never refuse, even on a repeat");
    assert.ok(r2.totalChunks > 0);
    assert.equal(r2.extraction, undefined);
  });

  test("a repeated plain-text payload from the same host reaches store.indexPlainText, never refuses", () => {
    const host = `text-route-${Date.now()}.example.com`;
    const payload = "field_a,field_b\n1,2\n3,4\n";

    const r1 = indexFetched({
      url: `https://${host}/a`, source: `s-text-a-${Date.now()}`,
      markdown: payload, header: "__CM_CT__:text", route: "text",
    });
    assert.equal(r1.refusal, undefined, "text route must never refuse");
    assert.ok(r1.totalChunks > 0, "store.indexPlainText must actually index the payload");
    assert.equal(r1.extraction, undefined, "extraction must not run for the text route");

    const r2 = indexFetched({
      url: `https://${host}/b`, source: `s-text-b-${Date.now()}`,
      markdown: payload, header: "__CM_CT__:text", route: "text",
    });
    assert.equal(r2.refusal, undefined, "text route must never refuse, even on a repeat");
    assert.ok(r2.totalChunks > 0);
    assert.equal(r2.extraction, undefined);
  });

  test("control: the SAME shell-shaped content under the html route DOES refuse on a repeat", () => {
    // Proves the harness is meaningful — a shell page genuinely trips the
    // refuse branch under the html route, so json/text NOT tripping it above
    // is `routeSkipsExtraction` doing its job, not an inert test.
    const host = `html-route-${Date.now()}.example.com`;
    const shell = `# Example\n\n${NAV}\n${FOOTER}`;

    indexFetched({
      url: `https://${host}/one`, source: `s-html-one-${Date.now()}`,
      markdown: page("## One\n\nFirst article body.\n"), header: "text/html", route: "html",
    });
    indexFetched({
      url: `https://${host}/two`, source: `s-html-two-${Date.now()}`,
      markdown: page("## Two\n\nSecond article body.\n"), header: "text/html", route: "html",
    });
    const r3 = indexFetched({
      url: `https://${host}/three`, source: `s-html-three-${Date.now()}`,
      markdown: shell, header: "text/html", route: "html",
    });
    assert.ok(r3.refusal, "a page that is entirely nav/footer chrome must refuse under the html route");
  });
});
