/**
 * Snapshot builder — converts stored SessionEvents into a reference-based
 * XML resume snapshot.
 *
 * Pure functions only. No database access, no file system, no side effects.
 *
 * The output XML is injected into the LLM's context after a compact event to
 * restore session awareness. Instead of truncated inline data, each section
 * contains a natural summary plus a runnable search tool call that retrieves
 * full details from the indexed knowledge base on demand.
 *
 * Full data lives in SessionDB; the snapshot is a table of contents, and is
 * bounded so it stays under the host's injected-context cap. Summaries are
 * truncated, never the underlying record: each section ships the search call
 * that retrieves its full events on demand.
 */

import { escapeXML } from "../truncate.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Stored event as read from SessionDB. */
export interface StoredEvent {
  type: string;
  category: string;
  data: string;
  priority: number;
  created_at?: string;
}

export interface BuildSnapshotOpts {
  maxBytes?: number;      // total snapshot budget; see DEFAULT_MAX_BYTES
  compactCount?: number;
  searchTool?: string;    // platform-specific tool name, default "ctx_search"
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_ACTIVE_FILES = 10;

/**
 * Hosts cap hook-injected context and silently swap the payload for a file
 * path plus a preview once it is exceeded (Claude Code: 10,000 characters on
 * hookSpecificOutput.additionalContext). An over-budget snapshot therefore
 * loses *everything*, not just its tail, and does so without an error — the
 * exact failure this snapshot exists to prevent. Stay under the cap.
 */
const DEFAULT_MAX_BYTES = 8000;

/** Per-section item cap — a section is a table of contents, not a transcript. */
const MAX_SECTION_ITEMS = 12;

/** Per-item payload cap. Full text stays in SessionDB, reachable via search. */
const MAX_ITEM_CHARS = 200;

/**
 * Reduce raw events to bounded, de-duplicated summary lines.
 *
 * Every section builder used to emit `ev.data` verbatim for every event, so a
 * long session produced a snapshot far larger than the host would accept. The
 * caller keeps the search tool call, which is what actually retrieves detail.
 */
function summarizeEvents(
  events: StoredEvent[],
  format: (ev: StoredEvent, body: string) => string,
): { lines: string[]; queryTerms: string[]; elided: number } {
  const seen = new Set<string>();
  const lines: string[] = [];
  const queryTerms: string[] = [];

  // Newest events carry the most resume value, so keep the tail.
  for (const ev of events.slice().reverse()) {
    const raw = ev.data ?? "";
    if (!raw || seen.has(raw)) continue;
    seen.add(raw);
    if (lines.length >= MAX_SECTION_ITEMS) continue;
    lines.push(format(ev, escapeXML(truncateForSnapshot(raw, MAX_ITEM_CHARS))));
    queryTerms.push(raw);
  }

  lines.reverse();
  return { lines, queryTerms, elided: Math.max(0, seen.size - lines.length) };
}

/** Render the "N more, search for them" footer a bounded section needs. */
function elidedNote(elided: number): string[] {
  return elided > 0
    ? [`    (+${elided} more — use the search call below to retrieve them)`]
    : [];
}

/**
 * Extract 2-4 keyword phrases from a list of strings for BM25 search queries.
 * Takes actual data values and picks representative terms.
 */
function buildQueries(items: string[], maxQueries = 4): string[] {
  const unique = [...new Set(items.filter(s => s.length > 0))];
  const selected = unique.slice(0, maxQueries);
  return selected.map(s => {
    // Take the first ~80 chars as a query — enough for BM25 matching
    const trimmed = s.length > 80 ? s.slice(0, 80) : s;
    return trimmed;
  });
}

/**
 * Format a runnable tool call block for a section.
 */
function toolCall(toolName: string, queries: string[]): string {
  if (queries.length === 0) return "";
  const escaped = queries.map(q => `"${escapeXML(q)}"`).join(", ");
  return `\n    For full details:\n    ${escapeXML(toolName)}(\n      queries: [${escaped}],\n      source: "session-events"\n    )`;
}

// ── Section builders ─────────────────────────────────────────────────────────

function buildFilesSection(fileEvents: StoredEvent[], searchTool: string): string {
  if (fileEvents.length === 0) return "";

  // Build per-file operation counts
  const fileMap = new Map<string, { ops: Map<string, number> }>();

  for (const ev of fileEvents) {
    const path = ev.data;
    let entry = fileMap.get(path);
    if (!entry) {
      entry = { ops: new Map() };
      fileMap.set(path, entry);
    }

    let op: string;
    if (ev.type === "file_write") op = "write";
    else if (ev.type === "file_read") op = "read";
    else if (ev.type === "file_edit") op = "edit";
    else op = ev.type;

    entry.ops.set(op, (entry.ops.get(op) ?? 0) + 1);
  }

  // Limit to last MAX_ACTIVE_FILES files (by insertion order = chronological)
  const entries = Array.from(fileMap.entries());
  const limited = entries.slice(-MAX_ACTIVE_FILES);

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const [path, { ops }] of limited) {
    const opsStr = Array.from(ops.entries())
      .map(([k, v]) => `${k}×${v}`)
      .join(", ");
    // Use just the filename for concise display
    const fileName = path.split("/").pop() ?? path;
    summaryLines.push(`    ${escapeXML(fileName)} (${escapeXML(opsStr)})`);
    queryTerms.push(`${fileName} ${Array.from(ops.keys()).join(" ")}`);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <files count="${fileMap.size}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </files>`,
  ];
  return lines.join("\n");
}

function buildErrorsSection(errorEvents: StoredEvent[], searchTool: string): string {
  if (errorEvents.length === 0) return "";

  const { lines: summaryLines, queryTerms, elided } = summarizeEvents(
    errorEvents,
    (_ev, body) => `    ${body}`,
  );

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <errors count="${errorEvents.length}">`,
    ...summaryLines,
    ...elidedNote(elided),
    toolCall(searchTool, queries),
    `  </errors>`,
  ];
  return lines.join("\n");
}

function buildDecisionsSection(decisionEvents: StoredEvent[], searchTool: string): string {
  if (decisionEvents.length === 0) return "";

  const { lines: summaryLines, queryTerms, elided } = summarizeEvents(
    decisionEvents,
    (_ev, body) => `    ${body}`,
  );

  if (summaryLines.length === 0) return "";

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <decisions count="${summaryLines.length + elided}">`,
    ...summaryLines,
    ...elidedNote(elided),
    toolCall(searchTool, queries),
    `  </decisions>`,
  ];
  return lines.join("\n");
}

function buildRulesSection(ruleEvents: StoredEvent[], searchTool: string): string {
  if (ruleEvents.length === 0) return "";

  // `rule_content` used to take its own branch here, but both branches emitted
  // the identical line (#1004) — and inlining a rule body verbatim duplicated
  // guidance the host already injects. One bounded form covers both.
  const { lines: summaryLines, queryTerms, elided } = summarizeEvents(
    ruleEvents,
    (_ev, body) => `    ${body}`,
  );

  if (summaryLines.length === 0) return "";

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <rules count="${summaryLines.length + elided}">`,
    ...summaryLines,
    ...elidedNote(elided),
    toolCall(searchTool, queries),
    `  </rules>`,
  ];
  return lines.join("\n");
}

function buildGitSection(gitEvents: StoredEvent[], searchTool: string): string {
  if (gitEvents.length === 0) return "";

  const { lines: summaryLines, queryTerms, elided } = summarizeEvents(
    gitEvents,
    (_ev, body) => `    ${body}`,
  );

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <git count="${gitEvents.length}">`,
    ...summaryLines,
    ...elidedNote(elided),
    toolCall(searchTool, queries),
    `  </git>`,
  ];
  return lines.join("\n");
}

/**
 * Render <task_state> from task events.
 * Reconstructs the full task list from create/update events,
 * filters out completed tasks, and renders only pending/in-progress work.
 *
 * TaskCreate events have `{ subject }`, TaskUpdate events have `{ taskId, status }`.
 * Match by chronological order: creates[0] -> lowest taskId from updates.
 */
export function renderTaskState(taskEvents: StoredEvent[]): string {
  if (taskEvents.length === 0) return "";

  const creates: string[] = [];
  const updates: Record<string, string> = {};

  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      if (typeof parsed.subject === "string") {
        creates.push(parsed.subject);
      } else if (typeof parsed.taskId === "string" && typeof parsed.status === "string") {
        updates[parsed.taskId] = parsed.status;
      }
    } catch { /* not JSON */ }
  }

  if (creates.length === 0) return "";

  const DONE = new Set(["completed", "deleted", "failed"]);

  // Match creates to updates positionally (creates[0] -> lowest taskId)
  const sortedIds = Object.keys(updates).sort((a, b) => Number(a) - Number(b));

  const pending: string[] = [];
  for (let i = 0; i < creates.length; i++) {
    const matchedId = sortedIds[i];
    const status = matchedId ? (updates[matchedId] ?? "pending") : "pending";
    if (!DONE.has(status)) {
      pending.push(creates[i]);
    }
  }

  // All tasks completed — nothing to render
  if (pending.length === 0) return "";

  const lines: string[] = [];
  for (const task of pending) {
    lines.push(`    [pending] ${escapeXML(task)}`);
  }
  return lines.join("\n");
}

function buildTaskSection(taskEvents: StoredEvent[], searchTool: string): string {
  const taskContent = renderTaskState(taskEvents);
  if (!taskContent) return "";

  const queryTerms: string[] = [];
  for (const ev of taskEvents) {
    try {
      const parsed = JSON.parse(ev.data) as Record<string, unknown>;
      if (typeof parsed.subject === "string") {
        queryTerms.push(parsed.subject);
      }
    } catch { /* not JSON */ }
  }

  const queries = buildQueries(queryTerms);
  const pendingCount = taskContent.split("\n").length;

  const lines = [
    `  <task_state count="${pendingCount}">`,
    taskContent,
    toolCall(searchTool, queries),
    `  </task_state>`,
  ];
  return lines.join("\n");
}

function buildEnvironmentSection(
  cwdEvents: StoredEvent[],
  envEvents: StoredEvent[],
  searchTool: string,
): string {
  if (cwdEvents.length === 0 && envEvents.length === 0) return "";

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  if (cwdEvents.length > 0) {
    const lastCwd = cwdEvents[cwdEvents.length - 1];
    summaryLines.push(`    cwd: ${escapeXML(lastCwd.data)}`);
    queryTerms.push("working directory");
  }

  for (const env of envEvents) {
    summaryLines.push(`    ${escapeXML(env.data)}`);
    queryTerms.push(env.data);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <environment>`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </environment>`,
  ];
  return lines.join("\n");
}

function buildSubagentsSection(subagentEvents: StoredEvent[], searchTool: string): string {
  if (subagentEvents.length === 0) return "";

  // Subagent payloads are whole delegated transcripts — the single largest
  // contributor to an unbounded snapshot. Summarize hard; search retrieves.
  const { lines: summaryLines, queryTerms, elided } = summarizeEvents(
    subagentEvents,
    (ev, body) => {
      const status = ev.type === "subagent_completed" ? "completed"
        : ev.type === "subagent_launched" ? "launched"
        : "unknown";
      return `    [${status}] ${body}`;
    },
  );

  const queries = buildQueries(queryTerms.map(t => `subagent ${t}`));
  const lines = [
    `  <subagents count="${subagentEvents.length}">`,
    ...summaryLines,
    ...elidedNote(elided),
    toolCall(searchTool, queries),
    `  </subagents>`,
  ];
  return lines.join("\n");
}

function buildSkillsSection(skillEvents: StoredEvent[], searchTool: string): string {
  if (skillEvents.length === 0) return "";

  // Count invocations per skill name
  const skillCounts = new Map<string, number>();
  for (const ev of skillEvents) {
    const name = ev.data.split(":")[0].trim();
    skillCounts.set(name, (skillCounts.get(name) ?? 0) + 1);
  }

  const summaryLines: string[] = [];
  const queryTerms: string[] = [];

  for (const [name, count] of skillCounts) {
    summaryLines.push(`    ${escapeXML(name)} (${count}×)`);
    queryTerms.push(`skill ${name} invocation`);
  }

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <skills count="${skillEvents.length}">`,
    ...summaryLines,
    toolCall(searchTool, queries),
    `  </skills>`,
  ];
  return lines.join("\n");
}

function buildRolesSection(roleEvents: StoredEvent[], searchTool: string): string {
  if (roleEvents.length === 0) return "";

  const { lines: summaryLines, queryTerms, elided } = summarizeEvents(
    roleEvents,
    (_ev, body) => `    ${body}`,
  );

  if (summaryLines.length === 0) return "";

  const queries = buildQueries(queryTerms);
  const lines = [
    `  <roles count="${summaryLines.length + elided}">`,
    ...summaryLines,
    ...elidedNote(elided),
    toolCall(searchTool, queries),
    `  </roles>`,
  ];
  return lines.join("\n");
}

function buildIntentSection(intentEvents: StoredEvent[]): string {
  if (intentEvents.length === 0) return "";
  const lastIntent = intentEvents[intentEvents.length - 1];
  return `  <intent mode="${escapeXML(lastIntent.data)}"/>`;
}

/**
 * Restore the most recent stated session goal verbatim. Placed at the top of
 * the snapshot (right after how_to_search) so the resuming LLM reads the
 * active objective before anything else and keeps working toward it.
 */
function buildGoalSection(goalEvents: StoredEvent[]): string {
  if (goalEvents.length === 0) return "";
  const lastGoal = goalEvents[goalEvents.length - 1];
  return [
    `  <session_goal>`,
    `  The active objective for this session. Keep working toward it until it is met; do not ask the user to restate it.`,
    `    ${escapeXML(lastGoal.data)}`,
    `  </session_goal>`,
  ].join("\n");
}

/**
 * Raw-prompt safety net (issue #535):
 * Always surface the most recent user prompts verbatim so the next LLM
 * sees them even if every universal-rule detector misses. Bound per-prompt
 * payload to RECENT_MESSAGE_MAX_CHARS Unicode codepoints; bound the total
 * count to RECENT_MESSAGES_LIMIT to keep the resume block compact.
 */
const RECENT_MESSAGES_LIMIT = 3;
const RECENT_MESSAGE_MAX_CHARS = 400;

function truncateForSnapshot(value: string, max: number): string {
  const codepoints = [...value];
  if (codepoints.length <= max) return value;
  return codepoints.slice(0, max).join("");
}

function buildRecentMessagesSection(userPromptEvents: StoredEvent[]): string {
  if (userPromptEvents.length === 0) return "";

  // Last N in chronological order — newest at the bottom mirrors the
  // way the user reads their own scrollback.
  const recent = userPromptEvents.slice(-RECENT_MESSAGES_LIMIT);

  const items = recent
    .map(ev => {
      const body = truncateForSnapshot(ev.data ?? "", RECENT_MESSAGE_MAX_CHARS);
      if (!body) return "";
      return `    <message>${escapeXML(body)}</message>`;
    })
    .filter(Boolean);

  if (items.length === 0) return "";

  return [
    `  <recent_user_messages count="${items.length}">`,
    ...items,
    `  </recent_user_messages>`,
  ].join("\n");
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build a reference-based resume snapshot XML string from stored session events.
 *
 * Algorithm:
 * 1. Group events by category
 * 2. For each non-empty category, build a bounded summary section with a
 *    runnable search tool call containing exact queries for full details
 * 3. Assemble sections most-valuable-first, stopping at `maxBytes`
 *
 * Detail is never lost: every section carries the search call that retrieves
 * the full events from SessionDB. What the budget drops is the *summary*, and
 * dropping the least valuable summary beats having the host discard all of it.
 */
export function buildResumeSnapshot(
  events: StoredEvent[],
  opts?: BuildSnapshotOpts,
): string {
  const compactCount = opts?.compactCount ?? 1;
  const searchTool = opts?.searchTool ?? "ctx_search";
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = new Date().toISOString();

  // ── Group events by category ──
  const fileEvents: StoredEvent[] = [];
  const taskEvents: StoredEvent[] = [];
  const ruleEvents: StoredEvent[] = [];
  const decisionEvents: StoredEvent[] = [];
  const cwdEvents: StoredEvent[] = [];
  const errorEvents: StoredEvent[] = [];
  const envEvents: StoredEvent[] = [];
  const gitEvents: StoredEvent[] = [];
  const subagentEvents: StoredEvent[] = [];
  const intentEvents: StoredEvent[] = [];
  const goalEvents: StoredEvent[] = [];
  const skillEvents: StoredEvent[] = [];
  const roleEvents: StoredEvent[] = [];
  const userPromptEvents: StoredEvent[] = [];

  for (const ev of events) {
    switch (ev.category) {
      case "file": fileEvents.push(ev); break;
      case "task": taskEvents.push(ev); break;
      case "rule": ruleEvents.push(ev); break;
      case "decision": decisionEvents.push(ev); break;
      case "cwd": cwdEvents.push(ev); break;
      case "error": errorEvents.push(ev); break;
      case "env": envEvents.push(ev); break;
      case "git": gitEvents.push(ev); break;
      case "subagent": subagentEvents.push(ev); break;
      case "intent": intentEvents.push(ev); break;
      case "goal": goalEvents.push(ev); break;
      case "skill": skillEvents.push(ev); break;
      case "role": roleEvents.push(ev); break;
      case "user-prompt": userPromptEvents.push(ev); break;
    }
  }

  // ── Build sections, most valuable on resume first ──
  // `pinned` sections survive the byte budget: without them a resumed session
  // does not know what it was doing. Everything else yields in listed order.
  const howToSearch = `  <how_to_search>
  Each section below contains a summary of prior work.
  For FULL DETAILS, run the exact tool call shown under each section.
  Do NOT ask the user to re-explain prior work. Search first.
  Do NOT invent your own queries — use the ones provided.
  </how_to_search>`;

  const candidates: Array<{ body: string; pinned?: boolean }> = [
    { body: howToSearch, pinned: true },
    { body: buildGoalSection(goalEvents), pinned: true },
    { body: buildTaskSection(taskEvents, searchTool), pinned: true },
    { body: buildRecentMessagesSection(userPromptEvents), pinned: true },
    { body: buildDecisionsSection(decisionEvents, searchTool) },
    { body: buildErrorsSection(errorEvents, searchTool) },
    { body: buildRulesSection(ruleEvents, searchTool) },
    { body: buildFilesSection(fileEvents, searchTool) },
    { body: buildEnvironmentSection(cwdEvents, envEvents, searchTool) },
    { body: buildGitSection(gitEvents, searchTool) },
    { body: buildSubagentsSection(subagentEvents, searchTool) },
    { body: buildSkillsSection(skillEvents, searchTool) },
    { body: buildRolesSection(roleEvents, searchTool) },
    { body: buildIntentSection(intentEvents) },
  ];

  const header = `<session_resume events="${events.length}" compact_count="${compactCount}" generated_at="${now}">`;
  const footer = `</session_resume>`;

  const sections: string[] = [];
  let used = header.length + footer.length + 4;
  let dropped = 0;

  for (const { body, pinned } of candidates) {
    if (!body) continue;
    const cost = body.length + 2;
    if (!pinned && used + cost > maxBytes) {
      dropped++;
      continue;
    }
    sections.push(body);
    used += cost;
  }

  if (dropped > 0) {
    sections.push(
      `  <elided sections="${dropped}">Lower-priority summaries omitted to stay within the host's injected-context limit. Their events remain searchable via ${escapeXML(searchTool)}.</elided>`,
    );
  }

  const body = sections.join("\n\n");
  if (body) {
    return `${header}\n\n${body}\n\n${footer}`;
  }
  return `${header}\n${footer}`;
}
