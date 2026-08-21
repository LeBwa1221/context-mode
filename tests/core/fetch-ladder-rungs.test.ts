/**
 * The fetch ladder, driven end to end over a real socket.
 *
 * A rung that exists is not a rung that fires. These tests run the REAL code
 * `buildFetchCode()` emits — real Turndown, real redirect walk, real SSRF
 * classification, real `emit()` — against a real HTTP server on loopback, and
 * assert two things per case:
 *
 *   1. WHICH RUNG ANSWERED, read off the subprocess's own stdout contract.
 *   2. HOW MANY REQUESTS IT COST, read off the server's request log. Cost order
 *      is the entire design claim: the cheap rungs must not pay for the
 *      expensive ones. A happy-path fetch that quietly makes three requests
 *      would pass every content assertion and still be the wrong product.
 *
 * The shapes below are the measured ones (scripts/measure-fetch-ladder.cjs,
 * 2026-08-12): developer.apple.com serves its `.md` with an EMPTY Content-Type
 * and an HTML comment as its first bytes, and angular.dev answers a missing
 * `.md` with HTTP 200 carrying the SPA shell.
 *
 * No regular expressions (repo-wide ban). Nothing truncated.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFetchCode, classifyExtraction, parseLadderTried } from "../../src/server.js";

// Shaped like the measured SPA shells: a title, a mount point, and script bulk
// that Turndown strips to nothing.
const SHELL_HTML =
  "<!doctype html><html><head><title>View | Documentation</title>" +
  `<style>${"a{color:red}".repeat(200)}</style>` +
  `<script>${"var x=1;".repeat(400)}</script>` +
  '</head><body><div id="root"></div></body></html>';

const ARTICLE_HTML =
  "<!doctype html><html><head><title>A Real Page</title></head><body><article>" +
  `<h1>Heading</h1><p>${"This sentence is genuine prose that survives conversion. ".repeat(40)}</p>` +
  "</article></body></html>";

// The Apple shape: an HTML comment carrying JSON metadata, THEN the article.
const APPLE_SHAPED_MD =
  '<!--\n{ "documentType" : "symbol", "title" : "View" }\n-->\n\n' +
  "# View\n\nA type that represents part of your app's user interface and provides\n" +
  "modifiers that you use to configure views.\n\n" +
  `${"Assemble the view's body by combining one or more of the built-in views. ".repeat(20)}\n`;

const RELOCATED_MD =
  "# View, published elsewhere\n\n" +
  `${"This host keeps its markdown on a path only llms.txt knows about. ".repeat(20)}\n`;

interface Case {
  /** path -> [status, content-type, body] */
  routes: Record<string, [number, string, string]>;
}

let server: Server;
let base = "";
let current: Case = { routes: {} };
let requestLog: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url || "/").split("?")[0];
    requestLog.push(path);
    const hit = current.routes[path];
    if (!hit) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const [status, ct, body] = hit;
    // An empty content-type is a real, measured server behaviour; Node needs
    // it omitted rather than set to "".
    res.writeHead(status, ct.length > 0 ? { "content-type": ct } : {});
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface RunResult {
  header: string;
  sourceBytes: number;
  route: string;
  rung: string;
  tried: string[];
  text: string;
  requests: string[];
}

// The HTTP server lives on THIS event loop, so the subprocess must be awaited
// asynchronously. A blocking spawnSync would deadlock: the server could never
// answer the request the child is waiting on.
async function run(pathname: string, routes: Case["routes"]): Promise<RunResult> {
  current = { routes };
  requestLog = [];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const outPath = join(tmpdir(), `ladder-out-${stamp}.dat`);
  const codePath = join(tmpdir(), `ladder-code-${stamp}.cjs`);
  try {
    writeFileSync(codePath, buildFetchCode(base + pathname, outPath));
    const proc = spawn(process.execPath, [codePath], { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += String(d); });
    proc.stderr.on("data", (d) => { stderr += String(d); });
    const status = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { proc.kill("SIGKILL"); }, 30_000);
      proc.on("close", (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(status, `subprocess stderr: ${stderr}`).toBe(0);
    const lines = stdout.trim().split("\n");
    return {
      header: (lines[0] || "").trim(),
      sourceBytes: Number.parseInt((lines[1] || "").trim(), 10),
      route: (lines[2] || "").trim(),
      rung: (lines[3] || "").trim(),
      tried: parseLadderTried(lines[4] || ""),
      text: existsSync(outPath) ? readFileSync(outPath, "utf-8") : "",
      requests: requestLog.slice(),
    };
  } finally {
    try { rmSync(codePath); } catch { /* already gone */ }
    try { rmSync(outPath); } catch { /* already gone */ }
  }
}

describe("rung 1 — the request we were already making", () => {
  test("site-served markdown answers, and costs exactly one request", async () => {
    const r = await run("/docs/view", {
      "/docs/view": [200, "text/markdown", APPLE_SHAPED_MD],
    });
    expect(r.rung).toBe("1-accept-markdown");
    expect(r.route).toBe("markdown");
    expect(r.text).toBe(APPLE_SHAPED_MD);
    expect(r.requests).toEqual(["/docs/view"]);
  });

  test("HTML that converts to an article answers, and does NOT climb", async () => {
    const r = await run("/docs/view", {
      "/docs/view": [200, "text/html", ARTICLE_HTML],
      // Present and never requested: the ladder must not pay for a rung it
      // does not need.
      "/docs/view.md": [200, "text/markdown", APPLE_SHAPED_MD],
    });
    expect(r.rung).toBe("1-html-converted");
    expect(r.route).toBe("html");
    expect(r.tried).toEqual([]);
    expect(r.requests).toEqual(["/docs/view"]);
    expect(classifyExtraction(r.text.trim().length, r.sourceBytes).kind).toBe("ok");
  });
});

describe("rung 2a — the page's .md sibling", () => {
  test("recovers a JavaScript shell, Apple-shaped: empty content-type, HTML comment first", async () => {
    const r = await run("/documentation/swiftui/view", {
      "/documentation/swiftui/view": [200, "text/html", SHELL_HTML],
      "/documentation/swiftui/view.md": [200, "", APPLE_SHAPED_MD],
    });
    expect(r.rung).toBe("2a-md-sibling");
    expect(r.route).toBe("markdown");
    expect(r.text).toBe(APPLE_SHAPED_MD);
    expect(r.text.includes("# View")).toBe(true);
    expect(r.requests).toEqual([
      "/documentation/swiftui/view",
      "/documentation/swiftui/view.md",
    ]);
  });

  test("a trailing-slash path tries the slash-stripped sibling first", async () => {
    const r = await run("/docs/getting-started/", {
      "/docs/getting-started/": [200, "text/html", SHELL_HTML],
      "/docs/getting-started.md": [200, "text/markdown", APPLE_SHAPED_MD],
    });
    expect(r.rung).toBe("2a-md-sibling");
    expect(r.requests[1]).toBe("/docs/getting-started.md");
  });

  test("a .html path tries the .md replacement, not a .html.md suffix", async () => {
    const r = await run("/3/library/csv.html", {
      "/3/library/csv.html": [200, "text/html", SHELL_HTML],
      "/3/library/csv.md": [200, "text/markdown", APPLE_SHAPED_MD],
    });
    expect(r.rung).toBe("2a-md-sibling");
    expect(r.requests[1]).toBe("/3/library/csv.md");
  });

  test("a soft 404 — HTTP 200 carrying the SPA shell — is REJECTED, not indexed as the article", async () => {
    const r = await run("/guide/components", {
      "/guide/components": [200, "text/html", SHELL_HTML],
      // angular.dev's measured behaviour: 200 + the shell for a missing .md.
      "/guide/components.md": [200, "text/html", SHELL_HTML],
      "/guide/components/index.md": [200, "text/html", SHELL_HTML],
    });
    expect(r.rung).toBe("ladder-exhausted");
    expect(r.text.includes("<div")).toBe(false); // the shell was converted, not echoed
    expect(classifyExtraction(r.text.trim().length, r.sourceBytes).kind).toBe("shell");
  });
});

describe("rung 2b — the host's llms.txt", () => {
  test("followed only when it names this page somewhere 2a did not already try", async () => {
    const r = await run("/docs/view", {
      "/docs/view": [200, "text/html", SHELL_HTML],
      "/llms.txt": [
        200,
        "text/plain",
        "# Docs\n\n- [Another page](/docs/other.md)\n- [View](/raw/docs/view.md)\n",
      ],
      "/raw/docs/view.md": [200, "text/markdown", RELOCATED_MD],
    });
    expect(r.rung).toBe("2b-llms-txt");
    expect(r.route).toBe("markdown");
    expect(r.text).toBe(RELOCATED_MD);
    expect(r.requests).toEqual([
      "/docs/view",
      "/docs/view.md",
      "/docs/view/index.md",
      "/llms.txt",
      "/raw/docs/view.md",
    ]);
  });

  test("an llms.txt that only names the url we already failed on is NOT re-fetched", async () => {
    const r = await run("/docs/view", {
      "/docs/view": [200, "text/html", SHELL_HTML],
      "/llms.txt": [200, "text/plain", "# Docs\n\n- [View](/docs/view)\n"],
    });
    expect(r.rung).toBe("ladder-exhausted");
    // The page path appears exactly once: the original fetch. No re-fetch.
    let pageHits = 0;
    for (const p of r.requests) if (p === "/docs/view") pageHits++;
    expect(pageHits).toBe(1);
  });
});

describe("rung 5 — the honest refusal", () => {
  test("every rung empty: the shell is still emitted whole and the tried urls are reported", async () => {
    const r = await run("/app/board", {
      "/app/board": [200, "text/html", SHELL_HTML],
    });
    expect(r.rung).toBe("ladder-exhausted");
    expect(r.route).toBe("html");
    expect(classifyExtraction(r.text.trim().length, r.sourceBytes).kind).toBe("shell");
    // The refusal can only name urls if the subprocess reported them.
    // two .md siblings, then llms.txt
    expect(r.tried.length).toBe(3);
    expect(r.tried[r.tried.length - 1].endsWith("/llms.txt")).toBe(true);
    // Nothing was truncated: the parent still receives the pre-conversion size.
    expect(r.sourceBytes).toBe(Buffer.byteLength(SHELL_HTML, "utf-8"));
  });
});

describe("the stdout contract stays backward compatible", () => {
  test("lines 0-2 keep their historical meaning; rung and tried are appended", async () => {
    const r = await run("/docs/view", { "/docs/view": [200, "application/json", '{"a":1}'] });
    expect(r.header).toBe("__CM_CT__:json");
    expect(r.sourceBytes).toBe(7);
    expect(r.route).toBe("json");
    expect(r.rung).toBe("1-json-passthrough");
    expect(r.tried).toEqual([]);
  });

  test("parseLadderTried never invents evidence", () => {
    expect(parseLadderTried("")).toEqual([]);
    expect(parseLadderTried("not json")).toEqual([]);
    expect(parseLadderTried('{"a":1}')).toEqual([]);
    expect(parseLadderTried('["https://a/", 7, "", "https://b/"]')).toEqual([
      "https://a/",
      "https://b/",
    ]);
  });
});
