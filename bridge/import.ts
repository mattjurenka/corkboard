// corkboard import: the card files' boards, copied to the Worker once.
//
//   bun bridge/import.ts [--dry-run] [board-key ...]
//
// With no keys, every board whose project still exists outside /tmp. Each
// card keeps its id, status, fields, description, log and times; front
// matter corkboard doesn't know (worktree, branch) goes in its extra. The
// Worker only imports into an empty board, so running it twice can't
// duplicate or overwrite anything. The files are left as they are.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENT_STATES, PRIORITIES, STATUSES, parse, split } from "../mcp/cards";
import { CLOUD, token } from "./cloud";

const DATA = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share");
const BOARDS = join(DATA, "corkboard", "boards");
const PROJECTS = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "corkboard", "projects");

const pathKey = (p: string) => p.replace(/^\//, "").replaceAll("/", "-");

// A board's project: the path corkboard opened it from, which the key can't
// give back unambiguously, so it's looked up in the projects corkboard knows.
function roots(): Map<string, string> {
  const known = existsSync(PROJECTS) ? readFileSync(PROJECTS, "utf8").split("\n").filter(Boolean) : [];
  return new Map(known.map((p) => [pathKey(p), p]));
}

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

function cardsOf(dir: string) {
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

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${CLOUD}/api/boards${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error ?? res.status}`);
  return json;
}

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const named = args.filter((a) => !a.startsWith("--"));
const known = roots();
const keys = named.length
  ? named
  : readdirSync(BOARDS).filter((k) => {
      const root = known.get(k);
      return root && !root.startsWith("/tmp/") && existsSync(root);
    });

for (const key of keys) {
  const dir = join(BOARDS, key);
  if (!existsSync(join(dir, "tasks"))) {
    console.error(`${key}: no such board in ${BOARDS}`);
    process.exitCode = 1;
    continue;
  }
  const root = known.get(key) ?? null;
  const name = readFileSync(join(dir, "config.yml"), "utf8").match(/^project_name:\s*'?([^'\n]+)'?/m)?.[1] ?? key;
  const cards = cardsOf(dir);
  const logs = cards.reduce((n, c) => n + c.log.length, 0);
  console.log(`${key}: ${cards.length} cards, ${logs} log entries${root ? `, from ${root}` : ""}`);
  if (dry) {
    for (const c of cards) console.log(`  ${c.id.padEnd(8)} ${c.status.padEnd(7)} ${c.title.slice(0, 60)}${Object.keys(c.extra).length ? `  +${Object.keys(c.extra).join(",")}` : ""}`);
    continue;
  }
  await api("PUT", `/${key}`, { name, root });
  await api("POST", `/${key}/import`, { cards });
  // Read back and compare, so a lost field shows here and not weeks later.
  const back: any[] = await api("GET", `/${key}/cards?log=1`);
  const byId = new Map(back.map((c) => [c.id, c]));
  const fields = ["title", "status", "agent", "agent_state", "attention", "priority", "ordinal", "labels", "dependencies", "description", "extra", "created", "updated"] as const;
  const wrong = cards.flatMap((c) => {
    const b = byId.get(c.id);
    if (!b) return [`${c.id} missing`];
    const off = fields.filter((f) => JSON.stringify(b[f]) !== JSON.stringify(c[f]));
    if (b.log.length !== c.log.length || b.log.some((e: any, i: number) => e.note !== c.log[i].note || e.at !== c.log[i].at)) off.push("log" as never);
    return off.length ? [`${c.id}: ${off.join(", ")}`] : [];
  });
  if (wrong.length) {
    console.error(`  read back differently:\n    ${wrong.join("\n    ")}`);
    process.exitCode = 1;
  } else console.log(`  imported and read back: all ${cards.length} cards match`);
}
