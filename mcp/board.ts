// The board as MCP tools, so an agent can list, claim and update cards
// without knowing where the card files live or how to edit them safely.
//
// Speaks MCP over stdio (newline-delimited JSON-RPC) and works on the card
// files directly; corkboard's directory watcher shows every change live. The
// card format is board.lua's, a Backlog.md board (parse/serialize there), and
// this must keep writing exactly what it reads.
//
// CORKBOARD_BOARD: the board directory. Unset, it is found the way board.lua
// finds it, from the main checkout's path, so agents in a worktree still
// reach their project's board.
// CORKBOARD_AGENT: who this agent is; every claim and log entry carries it.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

const STATUSES = ["backlog", "ready", "doing", "review", "done"];
const AGENT_STATES = ["queued", "working", "blocked", "needs-review", "done"];
// Backlog.md's keys in the order it writes them, then corkboard's own.
const KEY_ORDER = [
  "id", "title", "status", "assignee", "created_date", "updated_date",
  "labels", "dependencies", "ordinal", "agent_state", "attention",
];
const LISTS = ["assignee", "labels", "dependencies"];
const ME = process.env.CORKBOARD_AGENT || "claude";

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

const DIR =
  process.env.CORKBOARD_BOARD ||
  join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "corkboard",
    "boards",
    projectRoot().replace(/^\//, "").replaceAll("/", "-"),
  );
const TASKS = join(DIR, "tasks");

// Card files ------------------------------------------------------------------

// Front matter fields are strings, or string lists for LISTS. agent is the
// first assignee: corkboard works with one agent per card.
type Card = { id: string; path: string; body: string; agent?: string; [key: string]: any };

// Quote a string whenever YAML could read it as something else (a number,
// date, boolean, list or mapping), the way Backlog.md's dates are quoted.
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

const now = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// The id's number: TASK-12 -> 12.
const number = (id: string) => Number(id.match(/(\d+)$/)?.[1] ?? Infinity);

function filename(id: string, title: string): string {
  const slug = title.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60).replace(/^-+|-+$/g, "");
  return `${id.toLowerCase()} - ${slug || "card"}.md`;
}

function section(heading: string, name: string, text: string): string {
  const t = text.trim();
  return `## ${heading}\n\n<!-- SECTION:${name}:BEGIN -->\n${t ? t + "\n" : ""}<!-- SECTION:${name}:END -->\n`;
}

function sections(description: string, notes: string): string {
  return "\n" + section("Description", "DESCRIPTION", description) + "\n" + section("Implementation Notes", "NOTES", notes);
}

function parse(path: string): Card | undefined {
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

function serialize(card: Card): string {
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

// Write beside the card and rename over it, so the watcher never reads half
// a file.
function write(card: Card) {
  const tmp = join(TASKS, `.${card.id}.md.tmp`);
  writeFileSync(tmp, serialize(card));
  renameSync(tmp, card.path);
}

// Boards in the old format (NNN-slug.md at the top) are converted by
// corkboard the first time it opens them; this only reads the new one.
function tasks(): string[] {
  if (!existsSync(TASKS)) {
    let old = false;
    try {
      old = readdirSync(DIR).some((n) => /^\d+-.*\.md$/.test(n));
    } catch {}
    if (old) throw new Error(`the board at ${DIR} is in the old format; open it in corkboard once to convert it`);
    return [];
  }
  return readdirSync(TASKS).filter((n) => /^[a-z]+-\d+ - .*\.md$/i.test(n));
}

function list(): Card[] {
  const cards = tasks()
    .map((n) => parse(join(TASKS, n)))
    .filter((c): c is Card => !!c);
  const ordinal = (c: Card) =>
    c.ordinal !== undefined && c.ordinal !== "" && !isNaN(Number(c.ordinal)) ? Number(c.ordinal) : Infinity;
  return cards.sort((a, b) => ordinal(a) - ordinal(b) || number(a.id) - number(b.id));
}

// A card's file starts with its id; the rest is its title when created.
function find(id: string): Card {
  if (!/^[a-z]+-\d+$/i.test(id)) throw new Error(`bad card id ${id}; ids look like TASK-12`);
  const prefix = `${id.toLowerCase()} - `;
  for (const name of tasks().filter((n) => n.startsWith(prefix))) {
    const card = parse(join(TASKS, name));
    if (card?.id === id.toUpperCase()) return card;
  }
  throw new Error(`no card ${id}`);
}

// One writer per card at a time: mkdir either makes the lock or fails. A lock
// older than a few seconds is from a process that died holding it.
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
function change(id: string, fn: (card: Card) => void): Card {
  return locked(id, () => {
    const card = find(id);
    fn(card);
    card.updated_date = now();
    write(card);
    return card;
  });
}

// The text between a section's markers, if it has them.
function block(body: string, name: string): string | undefined {
  return body.match(new RegExp(`<!-- SECTION:${name}:BEGIN -->\\n?([\\s\\S]*?)<!-- SECTION:${name}:END -->`))?.[1];
}

// The body is the description, then the implementation notes: the log.
function split(body: string): { description: string; log: string } {
  return {
    description: block(body, "DESCRIPTION") ?? body.split(/^## Implementation Notes[ \t]*$/m)[0],
    log: block(body, "NOTES") ?? "",
  };
}

const NOTES_END = "<!-- SECTION:NOTES:END -->";

function appendLog(card: Card, note: string) {
  const time = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  // Continuation lines are indented so they stay part of the entry.
  const entry = `- ${time} ${ME}: ${note.trim().replace(/\n/g, "\n  ")}\n`;
  const body = card.body ?? "";
  const at = body.lastIndexOf(NOTES_END);
  if (at < 0) card.body = body.replace(/\n*$/, "\n") + "\n" + section("Implementation Notes", "NOTES", entry);
  else card.body = body.slice(0, at).replace(/\n*$/, "\n") + entry + body.slice(at);
}

function holder(card: Card) {
  // A card queued for you is not yours until you claim it.
  if (card.agent !== ME) throw new Error(`card ${card.id} is held by ${card.agent || "nobody"}, not ${ME}; claim it first`);
  if (card.agent_state === "queued") throw new Error(`card ${card.id} is queued for you; claim it first`);
}

// attention: what the agent is asking of the user, one line. corkboard
// raises a desktop notification when it appears and clears it when the user
// opens the card; the agent's next state change clears it too.
function ask(card: Card, message: string, wait: boolean) {
  holder(card);
  const text = message.trim();
  if (!text) throw new Error("say what you need");
  const line = text.split("\n")[0].trim();
  card.attention = line.length > 200 ? line.slice(0, 199) + "…" : line;
  if (wait) card.agent_state = "blocked";
  appendLog(card, `${wait ? "blocked" : "needs you"}: ${text}`);
}

// The dependencies a card still waits on: those not done, and ids with no
// card, which can never be done.
function waitingOn(card: Card, cards = list()): string[] {
  const status = new Map(cards.map((c) => [c.id, c.status]));
  return (card.dependencies ?? [])
    .map((d: string) => d.toUpperCase())
    .filter((d: string) => status.get(d) !== "done")
    .map((d: string) => (status.has(d) ? d : `${d} (no such card)`));
}

function summary(c: Card, cards?: Card[]) {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    agent: c.agent ?? "",
    agent_state: c.agent_state ?? "",
    attention: c.attention ?? "",
    ordinal: c.ordinal ?? "",
    labels: c.labels ?? [],
    dependencies: c.dependencies ?? [],
    waiting_on: c.status === "done" ? [] : waitingOn(c, cards),
  };
}

function full(c: Card) {
  const { description, log } = split(c.body ?? "");
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) if (!["id", "path", "body"].includes(k)) fields[k] = v;
  return { id: c.id, ...fields, description: description.trim(), log: log.trim() };
}

function claim(id: string, force = false): Card {
  return change(id, (card) => {
    if (card.agent && card.agent !== ME) throw new Error(`card ${id} is held by ${card.agent}`);
    if (card.status === "done") throw new Error(`card ${id} is done`);
    const waiting = waitingOn(card);
    if (waiting.length && !force)
      throw new Error(`card ${id} waits on ${waiting.join(", ")}; pass force to claim it anyway`);
    if (card.agent === ME && card.agent_state === "working") return;
    card.status = "doing";
    card.agent = ME;
    card.agent_state = "working";
    card.attention = "";
    appendLog(card, "claimed");
  });
}

function create(title: string, body = "", status = "backlog", extra: Partial<Card> = {}): Card {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
  mkdirSync(TASKS, { recursive: true });
  tasks(); // refuses an old-format board
  // Numbering under a board-wide lock, so two agents can't get the same id.
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

// Tools -------------------------------------------------------------------------

type Tool = {
  description: string;
  properties?: Record<string, object>;
  required?: string[];
  run: (args: any) => unknown;
};

const str = (description: string) => ({ type: "string", description });
const id = str("Card id, e.g. TASK-4");
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const labels = strings("Labels, replacing the card's");
const dependencies = strings("Ids of cards this one waits on, e.g. TASK-4; replaces the card's");
const cleanList = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);

const TOOLS: Record<string, Tool> = {
  list_cards: {
    description: "List cards (without their bodies), ordered by ordinal then id. Filters are optional and combine.",
    properties: {
      status: { type: "string", enum: STATUSES },
      agent_state: { type: "string", enum: AGENT_STATES },
      agent: str("Only cards held by this agent"),
      mine: { type: "boolean", description: "Only cards held by you" },
    },
    run: (a) => {
      const cards = list();
      return cards
        .filter((c) => !a.status || c.status === a.status)
        .filter((c) => !a.agent_state || c.agent_state === a.agent_state)
        .filter((c) => !a.agent || c.agent === a.agent)
        .filter((c) => !a.mine || c.agent === ME)
        .map((c) => summary(c, cards));
    },
  },
  read_card: {
    description: "Read a card: its fields, description and log.",
    properties: { id },
    required: ["id"],
    run: (a) => full(find(a.id)),
  },
  next_card: {
    description:
      "Claim the next card to work on and return it: a card queued for you first, else the top unassigned card in ready. Cards still waiting on dependencies are skipped. Returns null when there is nothing to do.",
    run: () => {
      const cards = list();
      const candidates = [
        ...cards.filter((c) => c.agent === ME && c.agent_state === "queued"),
        ...cards.filter((c) => c.status === "ready" && !c.agent),
      ].filter((c) => !waitingOn(c, cards).length && !c.budget_hold);
      for (const c of candidates) {
        try {
          return full(claim(c.id));
        } catch {} // taken by another agent meanwhile; try the next
      }
      return null;
    },
  },
  claim_card: {
    description:
      "Start work on a card: sets status doing, agent to you, agent_state working. Fails if another agent holds it, or if it waits on cards that aren't done (unless force).",
    properties: { id, force: { type: "boolean", description: "Claim it even though its dependencies aren't done" } },
    required: ["id"],
    run: (a) => full(claim(a.id, a.force === true)),
  },
  release_card: {
    description: "Give up a card you hold without finishing it; it goes back to ready, unassigned.",
    properties: { id, note: str("Why you are letting it go") },
    required: ["id", "note"],
    run: (a) =>
      summary(
        change(a.id, (c) => {
          holder(c);
          c.status = "ready";
          c.agent = "";
          c.agent_state = "";
          c.attention = "";
          appendLog(c, `released: ${a.note}`);
        }),
      ),
  },
  log: {
    description: "Append a timestamped entry to the card's implementation notes (its log). Use it for progress, decisions and findings.",
    properties: { id, note: str("The entry; markdown is fine") },
    required: ["id", "note"],
    run: (a) => summary(change(a.id, (c) => appendLog(c, a.note))),
  },
  block: {
    description:
      "You need a human decision: marks the card blocked, logs your question and sends the user a desktop notification. Stop working on it until it is answered.",
    properties: { id, question: str("What you need decided, with the options you see. The first line is the notification.") },
    required: ["id", "question"],
    run: (a) => summary(change(a.id, (c) => ask(c, String(a.question), true))),
  },
  request_user_action: {
    description:
      "Ask the user to do something only they can (log in somewhere, approve a change, check something on a device, look at a result). Sends them a desktop notification and shows the request on the card. With wait (the default) the card is marked blocked and you should stop until it is done; with wait: false you carry on meanwhile.",
    properties: {
      id,
      message: str("What you need them to do, concretely. The first line is the notification."),
      wait: { type: "boolean", description: "Whether you are stopped until they do it (default true)" },
    },
    required: ["id", "message"],
    run: (a) => summary(change(a.id, (c) => ask(c, String(a.message), a.wait !== false))),
  },
  submit_for_review: {
    description: "You finished a card: moves it to review and logs what changed and how you verified it.",
    properties: { id, summary: str("What changed"), verification: str("How you checked it works") },
    required: ["id", "summary", "verification"],
    run: (a) =>
      summary(
        change(a.id, (c) => {
          holder(c);
          c.status = "review";
          c.agent_state = "needs-review";
          c.attention = "";
          appendLog(c, `${a.summary}\nVerified: ${a.verification}`);
        }),
      ),
  },
  update_card: {
    description:
      "Change a card's title, status, ordinal, labels, dependencies or agent_state. Only the agent holding a card may change its agent_state.",
    properties: {
      id,
      title: str("New title"),
      status: { type: "string", enum: STATUSES },
      ordinal: { type: "number", description: "Lower sorts first within a column" },
      labels,
      dependencies,
      agent_state: { type: "string", enum: AGENT_STATES },
    },
    required: ["id"],
    run: (a) =>
      summary(
        change(a.id, (c) => {
          if (a.status !== undefined && !STATUSES.includes(a.status)) throw new Error(`status must be one of ${STATUSES.join(", ")}`);
          if (a.agent_state !== undefined) {
            if (!AGENT_STATES.includes(a.agent_state)) throw new Error(`agent_state must be one of ${AGENT_STATES.join(", ")}`);
            holder(c);
          }
          if (a.title !== undefined) c.title = String(a.title).replace(/\n/g, " ").trim();
          if (a.status !== undefined) c.status = a.status;
          if (a.ordinal !== undefined) c.ordinal = String(a.ordinal);
          if (a.labels !== undefined) c.labels = cleanList(a.labels);
          if (a.dependencies !== undefined) c.dependencies = cleanList(a.dependencies);
          if (a.agent_state !== undefined) {
            c.agent_state = a.agent_state;
            c.attention = "";
          }
        }),
      ),
  },
  write_description: {
    description: "Replace a card's description. Its log is kept as it is; add to the log with the log tool.",
    properties: { id, description: str("The new description, markdown") },
    required: ["id", "description"],
    run: (a) =>
      summary(
        change(a.id, (c) => {
          const { log } = split(c.body ?? "");
          c.body = sections(String(a.description), log);
        }),
      ),
  },
  create_card: {
    description: "Create a card, e.g. for follow-up work you found. It goes in backlog unless you say otherwise.",
    properties: {
      title: str("One line"),
      description: str("What needs doing and why, markdown"),
      status: { type: "string", enum: STATUSES },
      labels,
      dependencies,
      parent: str("Id of the card this came out of; both cards get a log entry linking them"),
    },
    required: ["title"],
    run: (a) => {
      const card = create(String(a.title).replace(/\n/g, " ").trim(), a.description, a.status, {
        labels: cleanList(a.labels),
        dependencies: cleanList(a.dependencies),
      });
      if (a.parent) {
        find(a.parent);
        change(card.id, (c) => appendLog(c, `created from ${a.parent}`));
        change(a.parent, (c) => appendLog(c, `follow-up: ${card.id}`));
      }
      return summary(find(card.id));
    },
  },
};

// budget_hold: corkboard's budget guard (corkboard/budget.lua) stopped the
// agent on this card. Until the user answers, the agent may still read the
// card, ask (block, request_user_action) or let it go, but not work on it.
const HOLD_ALLOWS = new Set(["read_card", "block", "request_user_action", "release_card"]);

function held(tool: string, args: any) {
  if (HOLD_ALLOWS.has(tool) || typeof args.id !== "string") return;
  const card = find(args.id);
  if (card.budget_hold)
    throw new Error(`budget reached on ${card.id}: ${card.budget_hold}. Stop working on it and wait; the user has been told and will answer on the card.`);
}

// MCP over stdio ----------------------------------------------------------------

const INSTRUCTIONS = `The corkboard project board: one card per task. You are "${ME}".
To pick up work, call next_card (or claim_card for a specific card). While working, log progress with log.
If you need a human decision, call block with your question and stop. If you need the user to do something
(log in, approve, test on a device), call request_user_action; both notify them on their desktop. When done, call submit_for_review.
Put follow-up work you discover in new cards with create_card (parent: the card you are on).`;

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function fail(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handle(msg: any) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "corkboard", version: "0.1.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
          inputSchema: { type: "object", properties: t.properties ?? {}, required: t.required ?? [] },
        })),
      });
    case "tools/call": {
      const tool = TOOLS[params?.name];
      if (!tool) return fail(id, -32602, `unknown tool ${params?.name}`);
      try {
        held(params.name, params.arguments ?? {});
        const out = tool.run(params.arguments ?? {});
        return reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e: any) {
        // Tool errors go back to the model as a result it can act on.
        return reply(id, { content: [{ type: "text", text: String(e?.message ?? e) }], isError: true });
      }
    }
    default:
      // Notifications (no id) need no answer.
      if (id !== undefined) fail(id, -32601, `unknown method ${method}`);
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    fail(null, -32700, "parse error");
    continue;
  }
  handle(msg);
}
