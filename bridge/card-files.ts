// A board's card files (the boards before the node's, in the data
// directory's boards/<key>/tasks) as cards with their logs, for e2ee.ts's
// push-board --local.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_STATES, PRIORITIES, STATUSES, parse, split } from "../mcp/cards";

const KNOWN = new Set(["id", "title", "status", "assignee", "created_date", "updated_date", "labels", "dependencies", "priority", "ordinal", "agent_state", "attention", "path", "body", "agent"]);

// 'yyyy-mm-dd hh:mm', local time, as the files write it, to ISO UTC.
function iso(local: string | undefined, fallback: string): string {
  const m = local?.match(/^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/);
  if (!m) return fallback;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).toISOString().replace(/\.\d+Z$/, "Z");
}

// The NOTES section's `- <ISO time> <who>: <note>` entries, continuation
// lines included. Text that isn't an entry is kept, as an entry of its own.
function entries(log: string, at: string) {
  const out: { at: string; who: string; note: string }[] = [];
  for (const line of log.split("\n")) {
    const m = line.match(/^- (\d{4}-\d\d-\d\dT[\d:]+Z) ([^:]+): (.*)$/);
    if (m) out.push({ at: m[1], who: m[2], note: m[3] });
    else if (out.length && line.startsWith("  ")) out.at(-1)!.note += "\n" + line.slice(2);
    else if (line.trim()) out.push({ at, who: "import", note: line.trim() });
  }
  return out.filter((e) => e.note.trim());
}

// A board's card files, from its directory.
export function cardsOf(dir: string) {
  const tasks = join(dir, "tasks");
  const files = readdirSync(tasks).filter((n) => /^[a-z]+-\d+ - .*\.md$/i.test(n));
  return files.map((name) => {
    const c = parse(join(tasks, name))!;
    const { description, log } = split(c.body ?? "");
    const created = iso(c.created_date, new Date().toISOString().replace(/\.\d+Z$/, "Z"));
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c)) if (!KNOWN.has(k) && v !== undefined && v !== "") extra[k] = v;
    // More than one assignee: the first is the agent, the rest are kept.
    if ((c.assignee ?? []).length > 1) extra.assignee = c.assignee;
    const ordinal = c.ordinal !== undefined && c.ordinal !== "" && !isNaN(Number(c.ordinal)) ? Number(c.ordinal) : null;
    return {
      id: c.id,
      title: c.title,
      status: STATUSES.includes(c.status) ? c.status : "backlog",
      agent: c.agent || null,
      agent_state: AGENT_STATES.includes(c.agent_state) ? c.agent_state : null,
      attention: c.attention || null,
      priority: PRIORITIES.includes(c.priority) ? c.priority : null,
      ordinal,
      labels: c.labels ?? [],
      dependencies: (c.dependencies ?? []).map((d: string) => d.toUpperCase()),
      description: description.trim(),
      extra,
      created,
      updated: iso(c.updated_date, created),
      log: entries(log, created),
    };
  });
}
