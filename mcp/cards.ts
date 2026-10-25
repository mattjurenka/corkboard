// Card files, the TypeScript twin of nvim/lua/corkboard/cards.lua: the same
// Backlog.md format, the same per-card locks, the same write-then-rename.
// The two must write exactly what the other reads; test/cards.test.ts checks.
//
// CORKBOARD_BOARD: the board directory. Unset, it is found from the main
// checkout's path the way cards.lua finds it from the cwd, so agents in a
// worktree still reach their project's board.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const STATUSES = ["backlog", "ready", "doing", "review", "done"];
export const AGENT_STATES = ["queued", "working", "blocked", "needs-review", "done"];
// Backlog.md's keys in the order it writes them, then corkboard's own.
const KEY_ORDER = [
  "id", "title", "status", "assignee", "created_date", "updated_date",
  "labels", "dependencies", "ordinal", "agent_state", "attention",
];
const LISTS = ["assignee", "labels", "dependencies"];

function projectRoot(): string {
  try {
    // The common dir is the main checkout's .git, from any worktree.
    const git = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirname(git);
  } catch {
    return process.cwd();
  }
}

export const DIR =
  process.env.CORKBOARD_BOARD ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "corkboard",
    "boards",
    projectRoot().replace(/^\//, "").replaceAll("/", "-"),
  );
const TASKS = join(DIR, "tasks");

// Front matter fields are strings, or string lists for LISTS. agent is the
// first assignee: one agent per card.
export type Card = { id: string; path: string; body: string; agent?: string; [key: string]: any };

// Quoted whenever YAML could read it as something else (a number, date,
// boolean, list or mapping), the way Backlog.md quotes its dates.
function quote(v: string): string {
  const plain =
    v !== "" &&
    !/^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(v) &&
    !/[\s:]$/.test(v) &&
    !v.includes(": ") &&
    !v.includes(" #") &&
    !/^[\d\s.:+-]+$/.test(v) &&
    !["true", "false", "null", "yes", "no", "on", "off", "~"].includes(v.toLowerCase());
  return plain ? v : `'${v.replaceAll("'", "''")}'`;
}

export const now = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// TASK-12 -> 12.
const number = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? Infinity);

function filename(id: string, title: string): string {
  const slug = title.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");
  return `${id.toLowerCase()} - ${slug || "card"}.md`;
}

function section(heading: string, name: string, text: string): string {
  const t = text.trim();
  return `## ${heading}\n\n<!-- SECTION:${name}:BEGIN -->\n${t ? t + "\n" : ""}<!-- SECTION:${name}:END -->\n`;
}

export function sections(description: string, notes: string): string {
  return "\n" + section("Description", "DESCRIPTION", description) + "\n" + section("Implementation Notes", "NOTES", notes);
}

export function parse(path: string): Card | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  let front: Record<string, unknown> = {};
  try {
    front = (m && (Bun.YAML.parse(m[1]) as Record<string, unknown>)) || {};
  } catch {} // a half-edited file reads as a card with no fields
  const card: Card = { id: "", path, body: m ? m[2] : text };
  for (const [k, v] of Object.entries(front)) {
    const items = (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
    card[k] = LISTS.includes(k) ? items : items[0];
  }
  const base = basename(path).replace(/\.md$/, "");
  if (!card.id) card.id = (base.match(/^([a-z]+-\d+) - /i)?.[1] ?? base).toUpperCase();
  if (!card.title) card.title = card.id;
  if (!STATUSES.includes(card.status)) card.status = "backlog";
  if (card.assignee) card.agent = card.assignee[0]?.replace(/^@/, "");
  return card;
}

export function serialize(card: Card): string {
  const lines = ["---"];
  const seen = new Set(["path", "body", "agent"]);
  const fields: Card = { ...card, assignee: [...(card.agent ? [card.agent] : []), ...(card.assignee ?? []).slice(1)] };
  const emit = (k: string) => {
    const v = fields[k];
    seen.add(k);
    if (Array.isArray(v)) {
      if (!v.length) lines.push(`${k}: []`);
      else lines.push(`${k}:`, ...v.map((item) => `  - ${quote(String(item))}`));
    } else if (v !== undefined && v !== "") {
      lines.push(`${k}: ${k === "ordinal" && v !== null && !isNaN(Number(v)) ? v : quote(String(v))}`);
    }
  };
  KEY_ORDER.forEach(emit);
  Object.keys(card).filter((k) => !seen.has(k)).sort().forEach(emit);
  lines.push("---");
  return lines.join("\n") + "\n" + (card.body ?? "");
}

// Beside the card, then renamed over it, so nobody reads half a file.
function write(card: Card) {
  const tmp = join(TASKS, `.${card.id}.md.tmp`);
  writeFileSync(tmp, serialize(card));
  renameSync(tmp, card.path);
}

function tasks(): string[] {
  if (!existsSync(TASKS)) return [];
  return readdirSync(TASKS).filter((n) => /^[a-z]+-\d+ - .*\.md$/i.test(n));
}

export function list(): Card[] {
  const cards = tasks()
    .map((n) => parse(join(TASKS, n)))
    .filter((c): c is Card => !!c);
  const ordinal = (c: Card) =>
    c.ordinal !== undefined && c.ordinal !== "" && !isNaN(Number(c.ordinal)) ? Number(c.ordinal) : Infinity;
  return cards.sort((a, b) => ordinal(a) - ordinal(b) || number(a.id) - number(b.id));
}

// A card's file starts with its id; the rest is its title when created.
export function find(id: string): Card {
  if (!/^[a-z]+-\d+$/i.test(id)) throw new Error(`bad card id ${id}; ids look like TASK-12`);
  const prefix = `${id.toLowerCase()} - `;
  for (const name of tasks().filter((n) => n.startsWith(prefix))) {
    const card = parse(join(TASKS, name));
    if (card?.id === id.toUpperCase()) return card;
  }
  throw new Error(`no card ${id}`);
}

// One writer per card: mkdir makes the lock or fails. A lock older than ten
// seconds is from a process that died holding it. cards.lua does the same.
function locked<T>(id: string, fn: () => T): T {
  const lock = join(TASKS, `.${id.toUpperCase()}.lock`);
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmdirSync(lock);
      } catch {}
      if (Date.now() > deadline) throw new Error(`card ${id} is busy; try again`);
      Bun.sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

// Read, change and write a card under its lock.
export function change(id: string, fn: (card: Card) => void): Card {
  return locked(id, () => {
    const card = find(id);
    fn(card);
    card.updated_date = now();
    write(card);
    return card;
  });
}

export function create(title: string, body = "", status = "backlog", extra: Partial<Card> = {}): Card {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  mkdirSync(TASKS, { recursive: true });
  // Numbered under a board-wide lock, so two writers can't take the same id.
  return locked("new", () => {
    const n = Math.max(0, ...tasks().map((name) => number(name.split(" - ")[0])));
    const id = `TASK-${n + 1}`;
    const card: Card = {
      labels: [],
      dependencies: [],
      ...extra,
      id,
      path: join(TASKS, filename(id, title)),
      title,
      status,
      created_date: now(),
      updated_date: now(),
      body: sections(body, ""),
    };
    write(card);
    return card;
  });
}

// The text between a section's markers, if it has them.
function block(body: string, name: string): string | undefined {
  return body.match(new RegExp(`<!-- SECTION:${name}:BEGIN -->\\n?([\\s\\S]*?)<!-- SECTION:${name}:END -->`))?.[1];
}

// The body is the description, then the implementation notes: the log.
export function split(body: string): { description: string; log: string } {
  return {
    description: block(body, "DESCRIPTION") ?? body.split(/^## Implementation Notes[ \t]*$/m)[0],
    log: block(body, "NOTES") ?? "",
  };
}

const NOTES_END = "<!-- SECTION:NOTES:END -->";

export function appendLog(card: Card, who: string, note: string) {
  const time = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  // Continuation lines are indented so they stay part of the entry.
  const entry = `- ${time} ${who}: ${note.trim().replace(/\n/g, "\n  ")}\n`;
  const body = card.body ?? "";
  const at = body.lastIndexOf(NOTES_END);
  if (at < 0) card.body = body.replace(/\n*$/, "\n") + "\n" + section("Implementation Notes", "NOTES", entry);
  else card.body = body.slice(0, at).replace(/\n*$/, "\n") + entry + body.slice(at);
}

// The dependencies a card still waits on: those not done, and ids with no
// card, which can never be done.
export function waitingOn(card: Card, cards = list()): string[] {
  const status = new Map(cards.map((c) => [c.id, c.status]));
  return (card.dependencies ?? [])
    .map((d: string) => d.toUpperCase())
    .filter((d: string) => status.get(d) !== "done")
    .map((d: string) => (status.has(d) ? d : `${d} (no such card)`));
}
