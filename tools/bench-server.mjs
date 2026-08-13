#!/usr/bin/env node
// Benchmark: MCP server (server.bundle.mjs) under real work, node vs bun.
// Usage: node tools/bench-server.mjs [--iterations=5] [--runtimes=node,bun]
//
// Unlike tools/bench-hooks.mjs (spawn-dominated, one process per call), the
// MCP server is long-running: it pays process-spawn cost once per session
// and then serves many tool calls. This measures per-operation latency for
// realistic CPU-bound work (indexing, FTS5/BM25 search) after the process is
// up, not startup - answering whether Bun's engine speed (measured ~1.6x
// faster for sustained work on this machine) shows up here the way it
// doesn't for hooks (which are dominated by Bun's per-spawn startup cost).
//
// Each iteration: spawn server fresh with an isolated CONTEXT_MODE_DIR,
// initialize, ctx_index 3 real files from this repo, ctx_search with 5
// separate query calls, then exit. Iteration 1 is reported separately
// (warm-up: JIT, first-touch caches) from iterations 2..N (steady state).

import { spawn, spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVER_PATH = resolve(ROOT, "server.bundle.mjs");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const ITER = Number(args.iterations ?? 5);
const RUNTIMES = String(args.runtimes ?? "node,bun").split(",");

// Real, sizable content from this repo - not synthetic - for indexing.
const INDEX_FILES = [
  resolve(ROOT, "README.md"),
  resolve(ROOT, "hooks/core/routing.mjs"),
  resolve(ROOT, "src/runtime.ts"),
].filter((p) => { try { readFileSync(p); return true; } catch { return false; } });

const SEARCH_QUERIES = [
  ["bun runtime detection"],
  ["FTS5 trigram tokenizer"],
  ["hook spawn process"],
  ["session continuity resume"],
  ["curl wget redirect security"],
];

function runtimeAvailable(name) {
  return spawnSync(name, ["--version"], { shell: true, encoding: "utf-8" }).status === 0;
}

class McpClient {
  constructor(bin, storageDir) {
    this.proc = spawn(bin, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CONTEXT_MODE_DIR: storageDir },
    });
    this.buf = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stderrBuf = "";
    this.proc.stdout.on("data", (d) => this._onData(d));
    this.proc.stderr.on("data", (d) => { this.stderrBuf += d.toString(); });
  }
  _onData(d) {
    this.buf += d.toString();
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id).resolve(msg);
        this.pending.delete(msg.id);
      }
    }
  }
  call(method, params, timeoutMs = 15000) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id}). stderr: ${this.stderrBuf.slice(-500)}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolvePromise(v); },
      });
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async callTool(name, toolArgs, timeoutMs) {
    const res = await this.call("tools/call", { name, arguments: toolArgs }, timeoutMs);
    if (res.error) throw new Error(`${name}: ${JSON.stringify(res.error)}`);
    if (res.result?.isError) throw new Error(`${name}: ${JSON.stringify(res.result)}`);
    return res.result;
  }
  kill() {
    try { this.proc.kill(); } catch {}
  }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function fmt(n) { return n.toFixed(1).padStart(8); }

async function runOnce(bin) {
  const storageDir = mkdtempSync(join(tmpdir(), "bench-server-"));
  const client = new McpClient(bin, storageDir);
  try {
    const t0 = performance.now();
    await client.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bench-server", version: "1.0" },
    });
    client.notify("notifications/initialized", {});
    const initMs = performance.now() - t0;

    const indexTimes = [];
    for (const filePath of INDEX_FILES) {
      const content = readFileSync(filePath, "utf-8");
      const t1 = performance.now();
      await client.callTool("ctx_index", { content, source: filePath });
      indexTimes.push(performance.now() - t1);
    }

    const searchTimes = [];
    for (const queries of SEARCH_QUERIES) {
      const t1 = performance.now();
      await client.callTool("ctx_search", { queries });
      searchTimes.push(performance.now() - t1);
    }

    return { initMs, indexTimes, searchTimes };
  } finally {
    client.kill();
    try { rmSync(storageDir, { recursive: true, force: true }); } catch {}
  }
}

const availableRuntimes = RUNTIMES.filter(runtimeAvailable);
if (availableRuntimes.length === 0) {
  console.error("No requested runtimes found on PATH:", RUNTIMES.join(", "));
  process.exit(1);
}

console.log(`Benchmark: ${ITER} iterations, runtimes: ${availableRuntimes.join(", ")}`);
console.log(`Indexing: ${INDEX_FILES.map((f) => f.split(/[\\/]/).pop()).join(", ")}`);
console.log(`Search: ${SEARCH_QUERIES.length} separate ctx_search calls\n`);

for (const rt of availableRuntimes) {
  const runs = [];
  for (let i = 0; i < ITER; i++) {
    try {
      runs.push(await runOnce(rt));
    } catch (err) {
      console.error(`  [${rt}] iteration ${i} FAILED: ${err.message}`);
    }
  }
  if (runs.length === 0) continue;

  const [warmup, ...steady] = runs;
  console.log(`=== ${rt} ===`);
  console.log(`  init (iter 1, includes spawn+handshake): ${fmt(warmup.initMs)} ms`);
  if (steady.length > 0) {
    console.log(`  init median (iter 2..${runs.length}, spawn+handshake, steady): ${fmt(median(steady.map((r) => r.initMs)))} ms`);
    const allIndex = steady.flatMap((r) => r.indexTimes);
    const allSearch = steady.flatMap((r) => r.searchTimes);
    console.log(`  ctx_index median (steady, n=${allIndex.length}): ${fmt(median(allIndex))} ms`);
    console.log(`  ctx_search median (steady, n=${allSearch.length}): ${fmt(median(allSearch))} ms`);
    const totalPerIter = steady.map((r) => r.initMs + r.indexTimes.reduce((a, b) => a + b, 0) + r.searchTimes.reduce((a, b) => a + b, 0));
    console.log(`  total per iteration median (steady): ${fmt(median(totalPerIter))} ms`);
  } else {
    console.log(`  (only 1 successful iteration - no steady-state data)`);
  }
  console.log("");
}
