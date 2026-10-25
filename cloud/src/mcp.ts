// The board as MCP tools, at /mcp: what mcp/board.ts did over stdio for one
// board's files, over MCP's streamable HTTP for the Worker's boards. Same
// tools, same descriptions and the same rules, so an agent can't tell the
// difference except that its writes reach the board everywhere at once.
//
// Stateless: each POST is a JSON-RPC message (or a batch) answered with JSON;
// there's no session and no server-to-client stream (GET is 405, as the
// transport allows).
//
// Who's calling decides what it sees (grant):
//   card       a token corkboard made for one agent on one card (POST
//              /api/tokens): its board, and only its own card to change
//   owner,     OAuth: every board, named by each tool's board argument
//   assistant

import type { Result } from "./board";
import { AGENT_STATES, type Card, type Fields, type LogEntry, STATUSES, waitingOn } from "./cards";
import type { Env } from "./index";

export type Grant =
  | { kind: "card"; board: string; card: string; agent: string }
  | { kind: "owner" | "assistant"; agent: string };

// The board's methods as this file calls them. Typed by hand: through
// DurableObjectStub, RPC's wrapping of the results defeats inference.
type Stub = {
  list(): Promise<Result<Card[]>>;
  get(id: string): Promise<Result<Card & { log: LogEntry[] }>>;
  create(f: Fields): Promise<Result<Card>>;
  update(id: string, f: Fields, version: number): Promise<Result<Card>>;
  appendLog(id: string, who: string, note: string): Promise<Result<LogEntry>>;
};

class ToolError extends Error {}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new ToolError(r.error);
  return r.value;
}

type Draft = Card & { logs: string[] };
const FIELDS = ["title", "status", "agent", "agent_state", "attention", "ordinal", "labels", "dependencies", "description", "extra"] as const;

// Read, change and write a card: fn changes a draft and queues log entries
// on it. Written with the version it read; if someone wrote the card since,
// fn runs again on the card as it is now. mcp/cards.ts's change(), with the
// board's versions where the files had locks.
async function change(board: Stub, me: string, id: string, fn: (c: Draft) => void): Promise<Card> {
  let { log: _, ...current } = unwrap(await board.get(id));
  for (let attempt = 0; attempt < 3; attempt++) {
    const draft: Draft = { ...structuredClone(current), logs: [] };
    fn(draft);
    const fields: Fields = {};
    for (const k of FIELDS) {
      if (JSON.stringify(draft[k]) !== JSON.stringify(current[k])) (fields as Record<string, unknown>)[k] = draft[k];
    }
    let written: Card = current;
    if (Object.keys(fields).length) {
      const r = await board.update(id, fields, current.version);
      if (!r.ok && r.status === 409 && r.card) {
        current = r.card;
        continue;
      }
      written = unwrap(r);
    }
    for (const note of draft.logs) unwrap(await board.appendLog(id, me, note));
    return written;
  }
  throw new ToolError(`card ${id} is busy; try again`);
}

const logText = (log: LogEntry[]) => log.map((e) => `- ${e.at} ${e.who}: ${e.note.replace(/\n/g, "\n  ")}`).join("\n");

function summary(c: Card, cards: Card[]) {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    agent: c.agent ?? "",
    agent_state: c.agent_state ?? "",
    attention: c.attention ?? "",
    ordinal: c.ordinal ?? "",
    labels: c.labels,
    dependencies: c.dependencies,
    waiting_on: waitingOn(c, cards),
  };
}

function full(c: Card & { log: LogEntry[] }) {
  const { log, extra, version: _, ...fields } = c;
  return { ...extra, ...fields, log: logText(log) };
}

// Tools ------------------------------------------------------------------------------

type Call = { board: Stub; key: string; me: string; grant: Grant; cards: () => Promise<Card[]> };
type Tool = {
  description: string;
  properties?: Record<string, object>;
  required?: string[];
  // Whether a card token may call it, and on which card: "own" checks that
  // the id argument is the token's card.
  card?: "any" | "own";
  run: (a: any, c: Call) => Promise<unknown>;
};

const str = (description: string) => ({ type: "string", description });
const id = str("Card id, e.g. TASK-4");
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const labels = strings("Labels, replacing the card's");
const dependencies = strings("Ids of cards this one waits on, e.g. TASK-4; replaces the card's");
const cleanList = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
const oneLine = (s: unknown) => String(s).replace(/\n/g, " ").trim();

// A card queued for you is not yours until you claim it.
function holder(card: Card, me: string) {
  if (card.agent !== me) throw new ToolError(`card ${card.id} is held by ${card.agent || "nobody"}, not ${me}; claim it first`);
  if (card.agent_state === "queued") throw new ToolError(`card ${card.id} is queued for you; claim it first`);
}

// attention: what the agent is asking of the user, one line. corkboard raises
// a desktop notification when it appears and clears it when the user opens
// the card; the agent's next state change clears it too.
function ask(card: Draft, me: string, message: string, wait: boolean) {
  holder(card, me);
  const text = message.trim();
  if (!text) throw new ToolError("say what you need");
  const line = text.split("\n")[0].trim();
  card.attention = line.length > 200 ? line.slice(0, 199) + "…" : line;
  if (wait) card.agent_state = "blocked";
  card.logs.push(`${wait ? "blocked" : "needs you"}: ${text}`);
}

async function claim(c: Call, cardId: string, force = false): Promise<Card> {
  const cards = await c.cards();
  return change(c.board, c.me, cardId, (card) => {
    if (card.agent && card.agent !== c.me) throw new ToolError(`card ${cardId} is held by ${card.agent}`);
    if (card.status === "done") throw new ToolError(`card ${cardId} is done`);
    const waiting = waitingOn(card, cards);
    if (waiting.length && !force) throw new ToolError(`card ${cardId} waits on ${waiting.join(", ")}; pass force to claim it anyway`);
    if (card.agent === c.me && card.agent_state === "working") return;
    card.status = "doing";
    card.agent = c.me;
    card.agent_state = "working";
    card.attention = null;
    card.logs.push("claimed");
  });
}

const read = async (c: Call, cardId: string) => full(unwrap(await c.board.get(cardId)));
const brief = async (c: Call, card: Card) => summary(card, await c.cards());

const TOOLS: Record<string, Tool> = {
  list_cards: {
    description: "List cards (without their bodies), ordered by ordinal then id. Filters are optional and combine.",
    properties: {
      status: { type: "string", enum: STATUSES },
      agent_state: { type: "string", enum: AGENT_STATES },
      agent: str("Only cards held by this agent"),
      mine: { type: "boolean", description: "Only cards held by you" },
    },
    card: "any",
    run: async (a, c) => {
      const cards = await c.cards();
      return cards
        .filter((x) => !a.status || x.status === a.status)
        .filter((x) => !a.agent_state || x.agent_state === a.agent_state)
        .filter((x) => !a.agent || x.agent === a.agent)
        .filter((x) => !a.mine || x.agent === c.me)
        .map((x) => summary(x, cards));
    },
  },
  read_card: {
    description: "Read a card: its fields, description and log.",
    properties: { id },
    required: ["id"],
    card: "any",
    run: (a, c) => read(c, a.id),
  },
  next_card: {
    description:
      "Claim the next card to work on and return it: a card queued for you first, else the top unassigned card in ready. Cards still waiting on dependencies are skipped. Returns null when there is nothing to do.",
    card: "any",
    run: async (_a, c) => {
      const cards = await c.cards();
      const candidates = [
        ...cards.filter((x) => x.agent === c.me && x.agent_state === "queued"),
        ...cards.filter((x) => x.status === "ready" && !x.agent),
      ]
        .filter((x) => !waitingOn(x, cards).length && !x.extra.budget_hold)
        // A card agent works on its own card and nothing else.
        .filter((x) => c.grant.kind !== "card" || x.id === c.grant.card);
      for (const x of candidates) {
        try {
          return await read(c, (await claim(c, x.id)).id);
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
    card: "own",
    run: async (a, c) => read(c, (await claim(c, a.id, a.force === true)).id),
  },
  release_card: {
    description: "Give up a card you hold without finishing it; it goes back to ready, unassigned.",
    properties: { id, note: str("Why you are letting it go") },
    required: ["id", "note"],
    card: "own",
    run: async (a, c) =>
      brief(
        c,
        await change(c.board, c.me, a.id, (x) => {
          holder(x, c.me);
          x.status = "ready";
          x.agent = null;
          x.agent_state = null;
          x.attention = null;
          x.logs.push(`released: ${a.note}`);
        }),
      ),
  },
  log: {
    description: "Append a timestamped entry to the card's implementation notes (its log). Use it for progress, decisions and findings.",
    properties: { id, note: str("The entry; markdown is fine") },
    required: ["id", "note"],
    card: "own",
    run: async (a, c) => brief(c, await change(c.board, c.me, a.id, (x) => x.logs.push(String(a.note).trim()))),
  },
  block: {
    description:
      "You need a human decision: marks the card blocked, logs your question and sends the user a desktop notification. Stop working on it until it is answered.",
    properties: { id, question: str("What you need decided, with the options you see. The first line is the notification.") },
    required: ["id", "question"],
    card: "own",
    run: async (a, c) => brief(c, await change(c.board, c.me, a.id, (x) => ask(x, c.me, String(a.question), true))),
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
    card: "own",
    run: async (a, c) => brief(c, await change(c.board, c.me, a.id, (x) => ask(x, c.me, String(a.message), a.wait !== false))),
  },
  submit_for_review: {
    description: "You finished a card: moves it to review and logs what changed and how you verified it.",
    properties: { id, summary: str("What changed"), verification: str("How you checked it works") },
    required: ["id", "summary", "verification"],
    card: "own",
    run: async (a, c) =>
      brief(
        c,
        await change(c.board, c.me, a.id, (x) => {
          holder(x, c.me);
          x.status = "review";
          x.agent_state = "needs-review";
          x.attention = null;
          x.logs.push(`${a.summary}\nVerified: ${a.verification}`);
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
    card: "own",
    run: async (a, c) =>
      brief(
        c,
        await change(c.board, c.me, a.id, (x) => {
          if (a.status !== undefined && !STATUSES.includes(a.status)) throw new ToolError(`status must be one of ${STATUSES.join(", ")}`);
          if (a.agent_state !== undefined) {
            if (!AGENT_STATES.includes(a.agent_state)) throw new ToolError(`agent_state must be one of ${AGENT_STATES.join(", ")}`);
            holder(x, c.me);
          }
          if (a.title !== undefined) x.title = oneLine(a.title);
          if (a.status !== undefined) x.status = a.status;
          if (a.ordinal !== undefined) {
            if (typeof a.ordinal !== "number" || !Number.isFinite(a.ordinal)) throw new ToolError("ordinal must be a number");
            x.ordinal = a.ordinal;
          }
          if (a.labels !== undefined) x.labels = cleanList(a.labels);
          if (a.dependencies !== undefined) x.dependencies = cleanList(a.dependencies).map((d) => d.toUpperCase());
          if (a.agent_state !== undefined) {
            x.agent_state = a.agent_state;
            x.attention = null;
          }
        }),
      ),
  },
  write_description: {
    description: "Replace a card's description. Its log is kept as it is; add to the log with the log tool.",
    properties: { id, description: str("The new description, markdown") },
    required: ["id", "description"],
    card: "own",
    run: async (a, c) => brief(c, await change(c.board, c.me, a.id, (x) => (x.description = String(a.description).trim()))),
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
    card: "any",
    run: async (a, c) => {
      const parent = a.parent ? String(a.parent).toUpperCase() : undefined;
      if (parent && c.grant.kind === "card" && parent !== c.grant.card)
        throw new ToolError(`you can only make follow-ups of your own card, ${c.grant.card}`);
      // Checked first, so a bad parent leaves no card behind.
      if (parent) unwrap(await c.board.get(parent));
      if (a.status !== undefined && !STATUSES.includes(a.status)) throw new ToolError(`status must be one of ${STATUSES.join(", ")}`);
      const title = oneLine(a.title);
      if (!title) throw new ToolError("a card needs a title");
      const card = unwrap(
        await c.board.create({
          title,
          description: typeof a.description === "string" ? a.description.trim() : "",
          status: a.status ?? "backlog",
          labels: cleanList(a.labels),
          dependencies: cleanList(a.dependencies).map((d) => d.toUpperCase()),
        }),
      );
      if (!parent) return brief(c, card);
      unwrap(await c.board.appendLog(parent, c.me, `follow-up: ${card.id}`));
      unwrap(await c.board.appendLog(card.id, c.me, `created from ${parent}`));
      return brief(c, card);
    },
  },
};

// budget_hold: corkboard's budget guard (corkboard/budget.lua) stopped the
// agent on this card. Until the user answers, the agent may still read the
// card, ask (block, request_user_action) or let it go, but not work on it.
const HOLD_ALLOWS = new Set(["read_card", "block", "request_user_action", "release_card"]);

const INSTRUCTIONS = (me: string) => `The corkboard project board: one card per task. You are "${me}".
To pick up work, call next_card (or claim_card for a specific card). While working, log progress with log.
If you need a human decision, call block with your question and stop. If you need the user to do something
(log in, approve, test on a device), call request_user_action; both notify them on their desktop. When done, call submit_for_review.
Put follow-up work you discover in new cards with create_card (parent: the card you are on).`;

// What a grant sees: a card token its board's tools, with no board argument;
// an OAuth client every tool with one, and list_boards.
function toolsFor(grant: Grant) {
  const tools = Object.entries(TOOLS)
    .filter(([, t]) => grant.kind !== "card" || t.card)
    .map(([name, t]) => {
      const properties = grant.kind === "card" ? (t.properties ?? {}) : { board: str("The board's key, from list_boards"), ...t.properties };
      const required = grant.kind === "card" ? (t.required ?? []) : ["board", ...(t.required ?? [])];
      return { name, description: t.description, inputSchema: { type: "object", properties, required } };
    });
  if (grant.kind !== "card")
    tools.unshift({
      name: "list_boards",
      description: "List the boards: their keys (for every other tool's board argument), names and project paths.",
      inputSchema: { type: "object", properties: {}, required: [] },
    });
  return tools;
}

async function callTool(env: Env, user: string, grant: Grant, name: string, args: any): Promise<unknown> {
  if (name === "list_boards" && grant.kind !== "card") return env.USER.get(env.USER.idFromName(user)).boards();
  const tool = TOOLS[name];
  if (!tool || (grant.kind === "card" && !tool.card)) throw new ToolError(`unknown tool ${name}`);
  const key = grant.kind === "card" ? grant.board : String(args.board ?? "");
  if (!key) throw new ToolError("say which board, from list_boards");
  const board = env.BOARD.get(env.BOARD.idFromName(`${user}/${key}`)) as unknown as Stub;
  if (args.id !== undefined) args.id = String(args.id).toUpperCase();
  if (grant.kind === "card" && tool.card === "own" && args.id !== grant.card)
    throw new ToolError(`this session works on ${grant.card}; it can read other cards but not change them`);
  if (!HOLD_ALLOWS.has(name) && typeof args.id === "string") {
    const { extra } = unwrap(await board.get(args.id));
    if (extra.budget_hold)
      throw new ToolError(
        `budget reached on ${args.id}: ${extra.budget_hold}. Stop working on it and wait; the user has been told and will answer on the card.`,
      );
  }
  let listed: Card[] | undefined;
  const cards = async () => (listed ??= unwrap(await board.list()));
  return tool.run(args, { board, key, me: grant.agent, grant, cards });
}

// JSON-RPC ----------------------------------------------------------------------------

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

async function handle(env: Env, user: string, grant: Grant, msg: Message): Promise<object | undefined> {
  const { id, method, params } = msg;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "corkboard", version: "0.2.0" },
        instructions: INSTRUCTIONS(grant.agent),
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolsFor(grant) });
    case "tools/call": {
      try {
        const out = await callTool(env, user, grant, String(params?.name), { ...(params?.arguments ?? {}) });
        return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        // Tool errors go back to the model as a result it can act on.
        if (e instanceof ToolError) return reply({ content: [{ type: "text", text: e.message }], isError: true });
        throw e;
      }
    }
    default:
      // Notifications (no id) need no answer.
      return id === undefined ? undefined : fail(-32601, `unknown method ${method}`);
  }
}

export async function mcp(request: Request, env: Env, user: string, grant: Grant): Promise<Response> {
  if (request.method !== "POST") return new Response("POST JSON-RPC here; this server has no stream", { status: 405, headers: { Allow: "POST" } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const batch = Array.isArray(body);
  const answers = (await Promise.all((batch ? (body as unknown[]) : [body]).map((m) => handle(env, user, grant, m as Message)))).filter(Boolean);
  // Only notifications: accepted, nothing to say.
  if (!answers.length) return new Response(null, { status: 202 });
  return Response.json(batch ? answers : answers[0]);
}
