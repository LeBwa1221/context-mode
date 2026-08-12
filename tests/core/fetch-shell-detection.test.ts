/**
 * Regression: a JavaScript-rendered shell must NOT be reported as a successful
 * fetch.
 *
 * THE DEFECT. The fetch path's only emptiness guard was `markdown.length === 0`.
 * excalidraw.com serves 6,862 bytes of bootstrap HTML whose entire text content
 * is its <title>; Turndown converts that to the 21 bytes "Excalidraw Whiteboard".
 * 21 is not 0, so the tool answered "fetched successfully", indexed the shell,
 * and the caller had no way to distinguish that from a genuinely short page.
 *
 * Numbers below are MEASURED against this exact code path (2026-08), not
 * invented — see the table in classifyExtraction()'s doc comment.
 *
 * Run: npx vitest run tests/core/fetch-shell-detection.test.ts
 */
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildFetchCode, classifyExtraction } from "../../src/server.js";

// ── Layer 1: the verdict itself, against real measured byte pairs ──────────

describe("classifyExtraction — measured pages", () => {
  // (label, sourceBytes, textBytes, expected)
  const MEASURED: Array<[string, number, number, "ok" | "shell"]> = [
    // The defect case. 0.31% yield, 21 bytes of text.
    ["excalidraw.com", 6862, 21, "shell"],
    // A shell too, but one whose HTML genuinely carries marketing prose.
    // 476 bytes is real text that truthfully describes the site: not a lie,
    // so not an error. Guarding this would be a false accusation.
    ["app.diagrams.net", 2759, 476, "ok"],
    // Server-rendered controls. Both must stay clean.
    ["nextjs.org", 316151, 13587, "ok"],
    ["developers.cloudflare.com", 178627, 8389, "ok"],
  ];

  for (const [label, sourceBytes, textBytes, expected] of MEASURED) {
    test(`${label}: ${sourceBytes}B in -> ${textBytes}B out is "${expected}"`, () => {
      expect(classifyExtraction(textBytes, sourceBytes).kind).toBe(expected);
    });
  }

  test("reports the evidence, so the caller can judge rather than trust", () => {
    const v = classifyExtraction(21, 6862);
    expect(v.kind).toBe("shell");
    if (v.kind !== "shell") throw new Error("unreachable");
    expect(v.textBytes).toBe(21);
    expect(v.sourceBytes).toBe(6862);
    expect(v.yieldPct).toBe("0.31");
  });
});

describe("classifyExtraction — pages that must never be accused", () => {
  test("a small but complete document: low text, but nearly all of it survived", () => {
    // "<html><body><p>Hello</p></body></html>" -> "Hello".
    // Tiny output, but 13% of the bytes were text. Not a shell.
    expect(classifyExtraction(5, 38).kind).toBe("ok");
  });

  test("plain text passes through 1:1 and is never a shell", () => {
    expect(classifyExtraction(12, 12).kind).toBe("ok");
  });

  test("pretty-printed JSON grows past its source and is never a shell", () => {
    expect(classifyExtraction(180, 90).kind).toBe("ok");
  });

  test("a long page with a poor ratio is still a real page", () => {
    // 200 bytes is the floor: at or above it we never accuse, whatever the ratio.
    expect(classifyExtraction(200, 10_000_000).kind).toBe("ok");
  });

  test("no evidence means no accusation (older bundle emits no byte count)", () => {
    expect(classifyExtraction(21, 0).kind).toBe("ok");
    expect(classifyExtraction(21, Number.NaN).kind).toBe("ok");
    expect(classifyExtraction(21, -1).kind).toBe("ok");
  });
});

// ── Layer 2: the wiring. Run the REAL generated subprocess, no network. ────
//
// A verdict function that is never called is not a guard. This drives the
// actual code buildFetchCode() emits — real Turndown, real remove() list, real
// emit() — with global fetch stubbed, and asserts the subprocess reports the
// pre-conversion byte count the parent's guard depends on.

function runGeneratedFetch(html: string, contentType: string): { header: string; sourceBytes: number; text: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outPath = join(tmpdir(), `shelltest-out-${stamp}.dat`);
  const codePath = join(tmpdir(), `shelltest-code-${stamp}.cjs`);

  const stub = `
globalThis.fetch = async function (u, init) {
  const headers = new Map([['content-type', ${JSON.stringify(contentType)}]]);
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
    text: async () => ${JSON.stringify(html)},
  };
};
`;

  try {
    writeFileSync(codePath, stub + buildFetchCode("https://example.invalid/", outPath));
    const proc = spawnSync(process.execPath, [codePath], {
      encoding: "utf-8",
      timeout: 30_000,
      cwd: process.cwd(),
    });
    expect(proc.status, `subprocess stderr: ${proc.stderr}`).toBe(0);
    const lines = (proc.stdout || "").trim().split("\n");
    return {
      header: (lines[0] || "").trim(),
      sourceBytes: Number.parseInt((lines[1] || "").trim(), 10),
      text: existsSync(outPath) ? readFileSync(outPath, "utf-8").trim() : "",
    };
  } finally {
    try { rmSync(codePath); } catch { /* already gone */ }
    try { rmSync(outPath); } catch { /* already gone */ }
  }
}

describe("generated subprocess reports pre-conversion bytes", () => {
  // Shaped like excalidraw.com: a title, a mountpoint, and script/style bulk
  // that Turndown strips to nothing. Padded so the yield lands where the real
  // page's does rather than relying on a handful of bytes.
  const SHELL_HTML =
    "<!doctype html><html><head><title>Excalidraw Whiteboard</title>" +
    `<style>${"a{color:red}".repeat(200)}</style>` +
    `<script>${"var x=1;".repeat(400)}</script>` +
    '</head><body><div id="root"></div>' +
    `<noscript>${"enable javascript ".repeat(20)}</noscript>` +
    "</body></html>";

  const ARTICLE_HTML =
    "<!doctype html><html><head><title>A Real Page</title></head><body><article>" +
    `<h1>Heading</h1><p>${"This sentence is genuine prose that survives conversion. ".repeat(40)}</p>` +
    "</article></body></html>";

  test("html: reports raw HTML byte length on stdout line 2", () => {
    const r = runGeneratedFetch(SHELL_HTML, "text/html; charset=utf-8");
    expect(r.header).toBe("__CM_CT__:html");
    expect(r.sourceBytes).toBe(Buffer.byteLength(SHELL_HTML, "utf-8"));
  });

  test("the shell survives conversion as non-empty text — which is the whole bug", () => {
    const r = runGeneratedFetch(SHELL_HTML, "text/html; charset=utf-8");
    // Non-empty: the OLD guard (`length === 0`) would have called this a success.
    expect(r.text.length).toBeGreaterThan(0);
    // And the NEW guard catches it.
    expect(classifyExtraction(r.text.length, r.sourceBytes).kind).toBe("shell");
  });

  test("a real article through the same path is reported ok", () => {
    const r = runGeneratedFetch(ARTICLE_HTML, "text/html; charset=utf-8");
    expect(r.header).toBe("__CM_CT__:html");
    expect(r.text.length).toBeGreaterThan(200);
    expect(classifyExtraction(r.text.length, r.sourceBytes).kind).toBe("ok");
  });

  test("plain text: byte count is reported and the body passes through", () => {
    const r = runGeneratedFetch("just a short note", "text/plain");
    expect(r.header).toBe("__CM_CT__:text");
    expect(r.sourceBytes).toBe(Buffer.byteLength("just a short note", "utf-8"));
    expect(classifyExtraction(r.text.length, r.sourceBytes).kind).toBe("ok");
  });

  test("json: line 1 keeps its exact historical shape for the downstream ===", () => {
    const r = runGeneratedFetch('{"a":1}', "application/json");
    expect(r.header).toBe("__CM_CT__:json");
    expect(r.sourceBytes).toBe(7);
  });
});

// ── Layer 3: the handler actually consults the verdict ────────────────────

describe("the fetch handler wires the verdict into its result", () => {
  const src = readFileSync(new URL("../../src/server.ts", import.meta.url), "utf-8");

  test("classifyExtraction is called on the success path, not merely defined", () => {
    // Guard against a refactor that keeps the function but drops the call.
    const callSites = src.split("classifyExtraction(").length - 1;
    // one definition signature + at least one call site
    expect(callSites).toBeGreaterThanOrEqual(2);
    expect(src.includes('reason: "shell"')).toBe(true);
  });
});
