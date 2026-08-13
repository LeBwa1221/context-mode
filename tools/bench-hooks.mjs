#!/usr/bin/env node
// Benchmark: bare runtime startup + hook end-to-end, node vs bun.
// Usage: node tools/bench-hooks.mjs [--iterations=10] [--runtimes=node,bun]
//
// Measures wall-clock spawn-to-exit time for each hook under each available
// runtime, using realistic stdin payloads. Prints median + p90 per cell.
// Runnable standalone - no deps beyond node:child_process.

import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const ITER = Number(args.iterations ?? 10);
const RUNTIMES = String(args.runtimes ?? "node,bun").split(",");

const SESSION_ID = "bench-session";

const PAYLOADS = {
  pretooluse: JSON.stringify({
    session_id: SESSION_ID,
    tool_name: "Bash",
    tool_input: { command: "ls -la", description: "list files" },
    cwd: ROOT,
  }),
  posttooluse: JSON.stringify({
    session_id: SESSION_ID,
    tool_name: "Bash",
    tool_input: { command: "ls -la", description: "list files" },
    tool_response: { stdout: "file1.txt\nfile2.txt\n", stderr: "", interrupted: false },
    cwd: ROOT,
  }),
  sessionstart: JSON.stringify({
    session_id: SESSION_ID,
    source: "startup",
    cwd: ROOT,
  }),
  userpromptsubmit: JSON.stringify({
    session_id: SESSION_ID,
    prompt: "bench prompt",
    cwd: ROOT,
  }),
  stop: JSON.stringify({
    session_id: SESSION_ID,
    cwd: ROOT,
  }),
};

const HOOKS = {
  pretooluse: resolve(ROOT, "hooks", "pretooluse.mjs"),
  posttooluse: resolve(ROOT, "hooks", "posttooluse.mjs"),
  sessionstart: resolve(ROOT, "hooks", "sessionstart.mjs"),
  userpromptsubmit: resolve(ROOT, "hooks", "userpromptsubmit.mjs"),
  stop: resolve(ROOT, "hooks", "stop.mjs"),
};

function findRuntimeBin(name) {
  const probe = spawnSync(name, ["--version"], { shell: true, encoding: "utf-8" });
  return probe.status === 0 ? name : null;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function p90(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))];
}

function fmt(n) {
  return n.toFixed(1).padStart(7);
}

function timeSpawn(bin, spawnArgs, input) {
  const t0 = performance.now();
  const res = spawnSync(bin, spawnArgs, { input, encoding: "utf-8" });
  const dt = performance.now() - t0;
  return { dt, ok: res.status === 0, stderr: res.stderr };
}

function bareStartup(bin, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const { dt } = timeSpawn(bin, ["-e", '""'], "");
    times.push(dt);
  }
  return times;
}

function hookRun(bin, hookPath, payload, n) {
  const times = [];
  let failures = 0;
  for (let i = 0; i < n; i++) {
    const { dt, ok } = timeSpawn(bin, [hookPath], payload);
    if (!ok) failures++;
    times.push(dt);
  }
  return { times, failures };
}

const availableRuntimes = RUNTIMES.filter(findRuntimeBin);
if (availableRuntimes.length === 0) {
  console.error("No requested runtimes found on PATH:", RUNTIMES.join(", "));
  process.exit(1);
}

console.log(`Benchmark: ${ITER} iterations per cell, runtimes: ${availableRuntimes.join(", ")}\n`);

const rows = [];

for (const rt of availableRuntimes) {
  const startupTimes = bareStartup(rt, ITER);
  rows.push({
    label: `bare startup (${rt})`,
    median: median(startupTimes),
    p90: p90(startupTimes),
  });
}

for (const [name, hookPath] of Object.entries(HOOKS)) {
  for (const rt of availableRuntimes) {
    const payload = PAYLOADS[name];
    const { times, failures } = hookRun(rt, hookPath, payload, ITER);
    rows.push({
      label: `${name} (${rt})${failures ? ` [${failures} FAILED]` : ""}`,
      median: median(times),
      p90: p90(times),
    });
  }
}

const labelWidth = Math.max(...rows.map((r) => r.label.length)) + 2;
console.log("label".padEnd(labelWidth) + "median(ms)".padStart(12) + "  p90(ms)".padStart(10));
for (const r of rows) {
  console.log(r.label.padEnd(labelWidth) + fmt(r.median).padStart(12) + fmt(r.p90).padStart(10));
}
