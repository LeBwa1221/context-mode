/**
 * The lossless invariant, in executable form.
 *
 * The whole "no data loss" claim rests on one property: splitting a converted
 * document into blocks is EXACTLY reversible. If `reassemble(splitBlocks(x))`
 * ever differs from `x` by a single byte, then labelling blocks silently
 * destroys bytes, and every downstream guarantee collapses.
 *
 * Covers blocks.ts and page-store.ts identity helpers only. Ported from
 * upstream's tests/fetch-extraction.test.ts (origin/next 5b9c00c); the
 * describe blocks exercising extract.ts (extractAndStore, store round trip)
 * are left for the phase that adds extract.ts.
 *
 * No regular expressions (repo-wide ban).
 */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import {
  splitBlocks,
  reassemble,
  classifyBlocks,
  contentText,
  templateText,
  hashBlockText,
  normalizeBlockText,
} from "../src/fetch/blocks.js";
import { pageKeyFor, hostFor } from "../src/fetch/page-store.js";

const NAV = "* [Home](/)\n* [Docs](/docs)\n* [Pricing](/pricing)\n";
const FOOTER = "(c) 2026 Example Inc. All rights reserved.\n";

function page(article: string): string {
  return `# Example\n\n${NAV}\n${article}\n${FOOTER}`;
}

const SAMPLES: Array<[string, string]> = [
  ["empty", ""],
  ["single line no newline", "just one line"],
  ["single line trailing newline", "just one line\n"],
  ["multi paragraph", "# Title\n\nFirst para.\n\nSecond para.\n"],
  ["crlf", "# Title\r\n\r\nBody with CRLF.\r\n"],
  ["fenced code", "# T\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.\n"],
  ["tilde fence", "# T\n\n~~~py\nx = 1\n\ny = 2\n~~~\n\nAfter.\n"],
  ["leading blanks", "\n\n\n# After blanks\n\nBody.\n"],
  ["trailing blanks", "# T\n\nBody.\n\n\n\n"],
  ["only blanks", "\n\n\n"],
  ["consecutive headings", "# A\n## B\n### C\n\nBody.\n"],
  ["unicode", "# Başlık\n\nTürkçe içerik — em dash, 日本語, emoji 🚀\n"],
  ["no trailing newline after fence", "```\ncode\n```"],
  ["nav page", page("## Article\n\nThe answer is 42.\n")],
];

describe("splitBlocks / reassemble — the lossless invariant", () => {
  for (const [name, sample] of SAMPLES) {
    test(`reassemble(splitBlocks(x)) === x byte-for-byte: ${name}`, () => {
      const blocks = splitBlocks(sample);
      const round = reassemble(blocks);
      assert.equal(round, sample, `round trip differed for ${name}`);
      assert.equal(
        Buffer.byteLength(round, "utf-8"),
        Buffer.byteLength(sample, "utf-8"),
        `byte length differed for ${name}`,
      );
    });
  }

  test("ordinals are dense and ascending from zero", () => {
    const blocks = splitBlocks(page("## Article\n\nBody.\n"));
    blocks.forEach((b, i) => assert.equal(b.ordinal, i));
  });

  test("content + template partition covers every byte of the document", () => {
    const doc = page("## Article\n\nThe answer is 42.\n");
    const blocks = splitBlocks(doc);
    const navHash = hashBlockText(NAV);
    const res = classifyBlocks({
      blocks,
      otherPageCount: (h) => (h === navHash ? 3 : 0),
      hostPageCount: 3,
    });
    // Every block landed in exactly one bucket, and the two buckets
    // reassemble to the whole document — nothing dropped, nothing duplicated.
    const rejoined = reassemble(res.blocks);
    assert.equal(rejoined, doc);
    assert.equal(res.blocks.length, blocks.length);
  });
});

describe("normalisation and hashing", () => {
  test("whitespace and case differences hash identically", () => {
    assert.equal(
      hashBlockText("* [Home](/)\n  * [Docs](/docs)"),
      hashBlockText("*   [home](/)\n\t* [DOCS](/docs)"),
    );
  });

  test("different text does not collide", () => {
    assert.notEqual(hashBlockText("alpha"), hashBlockText("beta"));
  });

  test("normalisation keeps punctuation — it must not over-match", () => {
    assert.notEqual(normalizeBlockText("a.b"), normalizeBlockText("ab"));
  });

  test("hash is a full sha256 digest, never shortened", () => {
    assert.equal(hashBlockText("anything").length, 64);
  });
});

describe("cold start", () => {
  test("first page of a host admits every block and is marked provisional", () => {
    const blocks = splitBlocks(page("## Article\n\nBody.\n"));
    const res = classifyBlocks({ blocks, otherPageCount: () => 0, hostPageCount: 0 });
    assert.equal(res.provisional, true);
    assert.equal(res.templateBytes, 0);
    assert.ok(res.blocks.every((b) => b.kind === "content"));
  });

  test("site-authored markdown is never provisional and never classified", () => {
    const blocks = splitBlocks("# Authored\n\nBody.\n");
    const res = classifyBlocks({
      blocks,
      otherPageCount: () => 99,
      hostPageCount: 50,
      authored: true,
    });
    assert.equal(res.provisional, false);
    assert.equal(res.templateBytes, 0);
    assert.ok(res.blocks.every((b) => b.kind === "content"));
  });

  test("a page is never compared against itself", () => {
    // otherPageCount excludes the current page by contract; with a single page
    // recorded for the host (itself), nothing may be called template.
    const blocks = splitBlocks(page("## Article\n\nBody.\n"));
    const res = classifyBlocks({ blocks, otherPageCount: () => 0, hostPageCount: 0 });
    assert.ok(res.blocks.every((b) => b.kind === "content"));
  });
});

describe("template detection across pages of a host", () => {
  test("repeated chrome becomes template; the article stays content", () => {
    const doc = page("## Article\n\nThe answer is 42.\n");
    const blocks = splitBlocks(doc);
    const navHash = hashBlockText(NAV);
    const footHash = hashBlockText(FOOTER);
    const res = classifyBlocks({
      blocks,
      otherPageCount: (h) => (h === navHash || h === footHash ? 4 : 0),
      hostPageCount: 4,
    });
    const content = contentText(res.blocks);
    const template = templateText(res.blocks);
    assert.ok(content.indexOf("The answer is 42.") >= 0, "article must survive");
    assert.ok(content.indexOf("[Pricing](/pricing)") === -1, "nav must leave the index");
    assert.ok(template.indexOf("[Pricing](/pricing)") >= 0, "nav must remain retrievable");
    assert.equal(res.allTemplate, false);
  });

  test("a page that is entirely chrome is flagged allTemplate", () => {
    const shell = `${NAV}\n${FOOTER}`;
    const blocks = splitBlocks(shell);
    const seen = new Set(blocks.map((b) => b.hash));
    const res = classifyBlocks({
      blocks,
      otherPageCount: (h) => (seen.has(h) ? 2 : 0),
      hostPageCount: 2,
    });
    assert.equal(res.allTemplate, true);
  });
});

describe("page identity", () => {
  test("fragment does not create a second page row", () => {
    assert.equal(
      pageKeyFor("https://example.com/a/b?x=1#frag"),
      pageKeyFor("https://example.com/a/b?x=1"),
    );
  });

  test("host is lower-cased", () => {
    assert.equal(hostFor("https://Docs.Stripe.COM/api"), "docs.stripe.com");
  });

  test("an unparseable url degrades to itself rather than throwing", () => {
    assert.equal(pageKeyFor("not a url"), "not a url");
    assert.equal(hostFor("not a url"), "");
  });
});
