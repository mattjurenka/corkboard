// The board as MCP tools, so an agent can list, claim and update cards
// without knowing where the card files live or how to edit them safely.
// Speaks MCP over stdio (newline-delimited JSON-RPC); the card files
// themselves are cards.ts's.
//
// CORKBOARD_AGENT: who this agent is; every claim and log entry carries it.
// CORKBOARD_BOARD: see cards.ts.

import { createInterface } from "node:readline";
import {
  AGENT_STATES, STATUSES, type Card, appendLog, change, create, find, list, sections, split, waitingOn,
} from "./cards";

const ME = process.env.CORKBOARD_AGENT || "claude";

const log = (card: Card, note: string) => appendLog(card, ME, note);

function holder(card: Card) {
  // A card queued for you is not yours until you claim it.
  if (card.agent !== ME) throw new Error(`card ${card.id} is held by ${card.agent || "nobody"}, not ${ME}; claim it first`);
  if (card.agent_state === "queued") throw new Error(`card ${card.id} is queued for you; claim it first`);
}

// attention: what the agent is asking of the user, one line. corkboard raises
// a desktop notification when it appears and clears it when the user opens
// the card; the agent's next state change clears it too.
function ask(card: Card, message: string, wait: boolean) {
  holder(card);
  const text = message.trim();
  if (!text) throw new Error("say what you need");
  const line = text.split("\n")[0].trim();
  card.attention = line.length > 200 ? line.slice(0, 199) + "…" : line;
  if (wait) card.agent_state = "blocked";
  log(card, `${wait ? "blocked" : "needs you"}: ${text}`);
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
  const fields: Record<string, unknown> = {};
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
    log(card, "claimed");
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
          log(c, `released: ${a.note}`);
        }),
      ),
  },
  log: {
    description: "Append a timestamped entry to the card's implementation notes (its log). Use it for progress, decisions and findings.",
    properties: { id, note: str("The entry; markdown is fine") },
    required: ["id", "note"],
    run: (a) => summary(change(a.id, (c) => log(c, a.note))),
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
          log(c, `${a.summary}\nVerified: ${a.verification}`);
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
      // Checked first, so a bad parent leaves no card behind.
      if (a.parent) find(a.parent);
      const card = create(String(a.title).replace(/\n/g, " ").trim(), a.description, a.status, {
        labels: cleanList(a.labels),
        dependencies: cleanList(a.dependencies),
      });
      if (!a.parent) return summary(card);
      change(a.parent, (c) => log(c, `follow-up: ${card.id}`));
      return summary(change(card.id, (c) => log(c, `created from ${a.parent}`)));
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
