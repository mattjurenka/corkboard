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
//   pepper     a token corkboard made for Pepper's session (POST
//              /api/tokens/pepper): what assistant sees, and the goals too
//   brain      a token for another brain's agents (POST /api/tokens/brain):
//              that brain's memory, its goals included, instead of Pepper's

import type { Result } from "./board";
import { AGENT_STATES, type Card, type Fields, type LogEntry, PRIORITIES, STATUSES, waitingOn } from "./cards";
import type { Env } from "./index";
import { Invalid } from "./cards";
import { BRAIN_ONLY_KINDS, NOTE_KINDS, OWNER_ONLY_NOTES, chatText, date, note, noteId, projects, proposal, slug, today } from "./plans";
import { range } from "./dates";
import type { Brain, Memory } from "./memory";
import type { User } from "./user";
import { Refused, spawn, status, stop } from "./fleet";
import { MAX_INLINE, MediaError, attach, fileName, fileType, offer } from "./media";

export type Grant =
  | { kind: "card"; board: string; card: string; agent: string }
  | { kind: "pepper"; agent: string }
  | { kind: "brain"; brain: Exclude<Brain, "pepper">; agent: string }
  // A server's (the droplet's): the API, but only its own environment's
  // fleet and sessions (api.ts's machine). Not for the MCP server.
  | { kind: "machine"; environment: string; agent: string }
  | { kind: "owner" | "assistant"; agent: string };

// The board's methods as this file calls them. Typed by hand: through
// DurableObjectStub, RPC's wrapping of the results defeats inference.
type Stub = {
  list(): Promise<Result<Card[]>>;
  get(id: string): Promise<Result<Card & { log: LogEntry[] }>>;
  create(f: Fields): Promise<Result<Card>>;
  update(id: string, f: Fields, version: number): Promise<Result<Card>>;
  appendLog(id: string, who: string, note: string): Promise<Result<LogEntry>>;
  touch(id: string, agent: string): Promise<Result<{ until: number } | null>>;
  archive(id: string, archived: boolean): Promise<Result<Card>>;
};

class ToolError extends Error {}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new ToolError(r.error);
  return r.value;
}

type Draft = Card & { logs: string[] };
const FIELDS = ["title", "status", "agent", "agent_state", "attention", "priority", "ordinal", "labels", "dependencies", "description", "extra"] as const;

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
    priority: c.priority ?? "",
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

type Call = { env: Env; user: string; board: Stub; key: string; me: string; grant: Grant; cards: () => Promise<Card[]> };
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
const priority = { type: "string", enum: [...PRIORITIES, ""], description: "high, medium or low; empty clears it, which counts as medium" };
// A priority from a tool call: one of PRIORITIES, or null for empty.
function priorityOf(v: unknown) {
  if (v === "" || v === null) return null;
  if (!PRIORITIES.includes(v as (typeof PRIORITIES)[number])) throw new ToolError(`priority must be one of ${PRIORITIES.join(", ")}`);
  return v as (typeof PRIORITIES)[number];
}
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
    description: "List cards (without their bodies), ordered by priority (high first; none is medium), then ordinal, then id. Filters are optional and combine.",
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
      "Change a card's title, status, priority, ordinal, labels, dependencies or agent_state. Only the agent holding a card may change its agent_state.",
    properties: {
      id,
      title: str("New title"),
      status: { type: "string", enum: STATUSES },
      priority,
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
          if (a.priority !== undefined) x.priority = priorityOf(a.priority);
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
  attach_file: {
    description:
      "Attach a file to a card for the user to look at in corkboard, beside your session: a screenshot, plot, recording, audio clip, PDF. Images, video, audio and PDFs play there; anything else can be downloaded. Pass data (base64) for a small file you have in hand; otherwise leave it out and you get an upload URL, good for an hour: run the command it gives (curl -T <path> <url>), and the file is on the card once that succeeds. Up to 100 MB.",
    properties: {
      id,
      name: str("The file's name, like plot.png; its extension gives its type"),
      type: str("Its MIME type, like video/mp4, if the name doesn't say"),
      data: str("The file, base64, for one under 4 MB; leave it out to upload it with curl instead"),
    },
    required: ["id", "name"],
    card: "own",
    run: async (a, c) => {
      const name = fileName(a.name);
      const type = fileType(name, a.type);
      if (a.data === undefined || a.data === null || a.data === "") {
        const { url, expires_at } = await offer(c.env, c.user, c.key, a.id, c.me, name, type);
        return { upload: url, expires_at, command: `curl -fsS -T <path to ${name}> ${url}` };
      }
      if (typeof a.data !== "string" || a.data.length > (MAX_INLINE * 4) / 3 + 4) throw new ToolError("data is base64 under 4 MB; upload a larger file with curl");
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(a.data.replace(/\s+/g, "")), (ch) => ch.charCodeAt(0));
      } catch {
        throw new ToolError("data must be base64");
      }
      return attach(c.env, c.user, c.key, a.id, c.me, name, type, bytes);
    },
  },
  // No card token may: an agent doesn't take its own or anyone's card off
  // the board. Deleting for good is the user's alone (the REST API).
  archive_card: {
    description:
      "Take a card off the board: it leaves the board and list_cards but is kept, and read_card still reads it. For cards that are finished with or no longer wanted. It must not be held by an agent at work.",
    properties: { id, note: str("Why it's being archived; goes in its log") },
    required: ["id", "note"],
    run: async (a, c) => {
      const card = unwrap(await c.board.get(a.id));
      if (card.agent && card.agent_state && ["queued", "working", "blocked"].includes(card.agent_state))
        throw new ToolError(`card ${a.id} is ${card.agent_state} with ${card.agent}; release it first`);
      unwrap(await c.board.appendLog(a.id, c.me, `archived: ${String(a.note).trim()}`));
      return brief(c, unwrap(await c.board.archive(a.id, true)));
    },
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
      priority,
      labels,
      dependencies,
      parent: str("Id of the card this came out of; both cards get a log entry linking them"),
      attention: str("What you're asking the user about this card, one line; corkboard notifies them. Not for card agents"),
    },
    required: ["title"],
    card: "any",
    run: async (a, c) => {
      const parent = a.parent ? String(a.parent).toUpperCase() : undefined;
      if (parent && c.grant.kind === "card" && parent !== c.grant.card)
        throw new ToolError(`you can only make follow-ups of your own card, ${c.grant.card}`);
      // A card agent asks about its own card (block, request_user_action);
      // this is for Pepper and other OAuth clients, which hold no card.
      if (a.attention !== undefined && c.grant.kind === "card") throw new ToolError("ask about your own card with request_user_action");
      const attention = typeof a.attention === "string" ? oneLine(a.attention) : "";
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
          priority: a.priority === undefined ? null : priorityOf(a.priority),
          labels: cleanList(a.labels),
          dependencies: cleanList(a.dependencies).map((d) => d.toUpperCase()),
          ...(attention ? { attention: attention.length > 200 ? attention.slice(0, 199) + "…" : attention } : {}),
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
(log in, approve, test on a device), call request_user_action; both notify them on their desktop. To show them a screenshot, plot,
recording or PDF, attach it to your card with attach_file; it appears beside your session. When done, call submit_for_review.
Put follow-up work you discover in new cards with create_card (parent: the card you are on).`;

// The user's own tools, for OAuth clients and Pepper, not card agents: the
// brain's memory (its notes, log and recall; its goals are its own agents'),
// the day plan, the chat with the user, which is Pepper's alone too, and
// the fleet (fleet.ts), which is the user's alone until Pepper spawns
// (agent-fleet.md, step 6).
// There's no tool to accept a plan; only the user does that, in corkboard.

// Whose memory a grant works in: a brain token's brain, and Pepper's for
// every other grant but a card's, as the notes were.
export const brainOf = (grant: Grant): Brain | undefined => (grant.kind === "card" ? undefined : grant.kind === "brain" ? grant.brain : "pepper");

// The note kinds a grant can't see in its brain: the goals, to all but the
// brain's own agents (Pepper's token, or the brain's). To it, those notes
// don't exist.
export const hiddenFor = (grant: Grant) => (grant.kind === "pepper" || grant.kind === "brain" ? [] : BRAIN_ONLY_KINDS);

export async function memoryOf(env: Env, user: string, brain: Brain) {
  const memory = env.MEMORY.get(env.MEMORY.idFromName(`${user}/${brain}`));
  await memory.open(user, brain);
  return memory;
}

type UserCall = { env: Env; user: string; users: DurableObjectStub<User>; memory: DurableObjectStub<Memory>; grant: Grant; timeZone: string };
type UserTool = {
  description: string;
  properties?: Record<string, object>;
  required?: string[];
  // Only for Pepper's token: to anyone else the tool doesn't exist.
  pepper?: true;
  // Only for the user's own clients (owner and assistant).
  user?: true;
  run: (a: any, c: UserCall) => Promise<unknown>;
};
const reaches = (t: UserTool, grant: Grant) =>
  grant.kind !== "card" && (!t.pepper || grant.kind === "pepper") && (!t.user || grant.kind === "owner" || grant.kind === "assistant");

const day = str("YYYY-MM-DD; today, where the user is, if left out");
const blockSchema = {
  type: "array",
  description:
    "The blocks, minutes since midnight. kind: work (planned), fixed (a calendar event, not yours to move) or off (meals, free time). title: 'Prefix: concrete action'. desc: the first physical step, which is what the block's notification says. project: a key from projects. card and board: the corkboard card it's for.",
  items: {
    type: "object",
    properties: {
      id: str("Unique within the plan; keep a block's id when you move it"),
      start: { type: "integer" },
      stop: { type: "integer" },
      title: str("One line"),
      kind: { type: "string", enum: ["work", "fixed", "off"] },
      desc: str("The first physical step"),
      project: str("Project key"),
      tag: str("Short label: deep, review, due Wed"),
      card: str("Card id"),
      board: str("Board key"),
      pinned: { type: "boolean" },
    },
    required: ["id", "start", "stop", "title", "kind"],
  },
};
const lineList = (description: string) => ({ type: "array", items: { type: "object" }, description });

function writable(id: string, grant: Grant) {
  if (OWNER_ONLY_NOTES.has(id) && grant.kind !== "owner") throw new ToolError(`only the user writes the ${id} note`);
}

const hidden = hiddenFor;
const kinds = (grant: Grant) => NOTE_KINDS.filter((k) => !hidden(grant).includes(k));

async function visible(id: string, c: UserCall) {
  const n = unwrap(await c.memory.note(id));
  if (hidden(c.grant).includes(n.kind)) throw new ToolError(`no note ${id}`);
  return n;
}

// Writing a note of a hidden kind, or over one, is refused.
async function unhidden(id: string, kind: unknown, c: UserCall) {
  const hide = hidden(c.grant);
  if (hide.includes(kind as string)) throw new ToolError(`kind must be one of ${kinds(c.grant).join(", ")}`);
  const was = await c.memory.note(id);
  if (was.ok && hide.includes(was.value.kind)) throw new ToolError(`the id ${id} is taken; choose another`);
}

const USER_TOOLS: Record<string, UserTool> = {
  notes_search: {
    description:
      "Search your notes: day records, decisions, projects, people, reviews, memory, drafts, and whatever else kind lists. With no query, the newest. Every word must match.",
    properties: { query: str("Words to find"), kind: { type: "string", enum: NOTE_KINDS }, limit: { type: "integer", description: "At most this many (default 20)" } },
    run: async (a, c) => c.memory.notes(a.query ? String(a.query) : undefined, a.kind, Math.min(Number(a.limit) || 20, 100), hidden(c.grant)),
  },
  note_read: {
    description: "Read a note.",
    properties: { id: str("The note's id") },
    required: ["id"],
    run: async (a, c) => visible(noteId(String(a.id)), c),
  },
  note_write: {
    description:
      "Write a note, replacing it if it exists. Without an id, one is made from the title. Returns the note, with its id and version. Pass the version you read to be refused if someone changed it since (0 for a note that must not exist yet).",
    properties: {
      id: str("lowercase-and-dashes; from the title if left out"),
      kind: { type: "string", enum: NOTE_KINDS },
      title: str("One line"),
      body: str("Markdown"),
      version: { type: "integer", description: "The note's version as you read it" },
    },
    required: ["kind", "title", "body"],
    run: async (a, c) => {
      const id = noteId(a.id ? String(a.id) : slug(String(a.title ?? "")));
      writable(id, c.grant);
      await unhidden(id, a.kind, c);
      if (a.version !== undefined && (!Number.isInteger(a.version) || a.version < 0)) throw new ToolError("version must be the note's version, from note_read");
      return unwrap(await c.memory.putNote(id, note(a), a.version));
    },
  },
  note_append: {
    description: "Add a timestamped line to a note, such as today's day record, without rewriting it.",
    properties: { id: str("The note's id"), text: str("What to add") },
    required: ["id", "text"],
    run: async (a, c) => {
      const id = noteId(String(a.id));
      writable(id, c.grant);
      await visible(id, c);
      if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("say what to add");
      return unwrap(await c.memory.appendNote(id, c.grant.agent, a.text));
    },
  },
  memory_context: {
    description:
      "What you start a session with: who you are and who the user is, the last few days' log and day records, and what you've learned. Your session start hook already loads it; call this after a long session to see it again.",
    properties: { budget: { type: "integer", description: "At most this many characters (default 24000)" } },
    run: async (a, c) => c.memory.context(Math.min(Math.max(Number(a.budget) || 24_000, 1000), 200_000), hidden(c.grant)),
  },
  memory_recall: {
    description:
      "Search everything you remember, notes and log alike, for any of the words; the best matches first, each with a snippet. Read a whole note with note_read.",
    properties: { query: str("What you're trying to remember, in words it would be written in"), limit: { type: "integer", description: "At most this many (default 15)" } },
    required: ["query"],
    run: async (a, c) => {
      if (typeof a.query !== "string" || !a.query.trim()) throw new ToolError("say what to recall");
      return c.memory.recall(a.query, Math.min(Number(a.limit) || 15, 50), hidden(c.grant));
    },
  },
  memory_remember: {
    description:
      "Write a line in today's log: something that happened, was decided or was learned, in a sentence or two that will make sense on its own later. Every agent of yours shares the log.",
    properties: { text: str("What to remember") },
    required: ["text"],
    run: async (a, c) => {
      if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("say what to remember");
      if (a.text.length > 4000) throw new ToolError("keep it under 4000 characters; a longer record is a note");
      return c.memory.remember(c.grant.agent, a.text);
    },
  },
  memory_log: {
    description:
      'The log for some days, oldest first: when as words ("yesterday", "last week", "last Tuesday", "Oct 24", "3 days ago") or from and to as YYYY-MM-DD. The dates are worked out for you; don\'t do date arithmetic yourself.',
    properties: {
      when: str("Which days, in words"),
      from: str("YYYY-MM-DD"),
      to: str("YYYY-MM-DD; from, if left out"),
    },
    run: async (a, c) => {
      let from: string, to: string;
      if (a.from) [from, to] = [date(a.from), a.to ? date(a.to) : date(a.from)];
      else {
        const r = range(String(a.when ?? "today"), today(c.timeZone));
        if (!r) throw new ToolError(`can't tell which days "${a.when}" means; say from and to`);
        [from, to] = [r.from, r.to];
      }
      if (to < from) throw new ToolError("to is before from");
      return { from, to, entries: await c.memory.entries(from, to) };
    },
  },
  memory_grep: {
    description: "Every line in your notes and log that contains this text, case ignored, newest notes first. For when you know the exact words.",
    properties: { text: str("The text to find"), limit: { type: "integer", description: "At most this many lines (default 50)" } },
    required: ["text"],
    run: async (a, c) => {
      if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("say what to find");
      return c.memory.grep(a.text.trim(), Math.min(Number(a.limit) || 50, 200), hidden(c.grant));
    },
  },
  plan_read: {
    description:
      "Read a day's plan: the day as accepted (its blocks, the ranked work, what's not today), any proposal waiting for the user, and asked: what the user has said to change since your last proposal.",
    properties: { date: day },
    run: async (a, c) => c.users.plan(a.date ? date(a.date) : today(c.timeZone)),
  },
  plan_propose: {
    description:
      "Propose a day plan, or a re-plan of the rest of one, for the user to accept in corkboard's day plan window; it replaces any proposal still waiting. blocks are the whole day as you'd have it (keep the ids of blocks you don't change, so the user sees only what changed). from: the time the re-plan starts. Accepting writes it to their calendar, which only the user can do. What they asked is answered by this proposal.",
    properties: {
      date: day,
      from: { type: "integer", description: "Minutes since midnight; changes before it aren't shown" },
      blocks: blockSchema,
      reasons: lineList("Why a re-plan, now: [{ text, source, tone }]"),
      why: { type: "object", description: "Block id to why it was added, moved or dropped" },
      ranked: lineList("The work you ranked, most important first: [{ title, project, est, why, block }]"),
      later: lineList("What's not today and when: [{ title, project, why }]"),
      inputs: lineList("What you looked at: [{ label, value, tone }]"),
      projects: lineList("The projects blocks refer to: [{ key, name, color }]; color is accent, review, working or special"),
    },
    required: ["blocks"],
    run: async (a, c) => {
      const d = a.date ? date(a.date) : today(c.timeZone);
      const p = proposal(a, c.grant.agent, []);
      const { answering: _, ...made } = p;
      return unwrap(await c.users.propose(d, made, a.projects === undefined ? undefined : projects(a.projects)));
    },
  },
  chat_read: {
    description:
      "Read your chat with the user, oldest first: what they said to you from their phone and what you answered. after: only messages after this id; without it, the newest 100.",
    properties: { after: { type: "integer", description: "A message id" } },
    pepper: true,
    run: async (a, c) => c.users.chat(Number.isInteger(a.after) && a.after > 0 ? a.after : 0, 100),
  },
  chat_send: {
    description: "Say something to the user in your chat; it reaches their phone at once. Plain text, no markdown.",
    properties: { text: str("What to say") },
    required: ["text"],
    pepper: true,
    run: async (a, c) => c.users.post("pepper", chatText(a.text)),
  },
  spawn_agent: {
    description:
      "Start an agent on a task, in a VM of its own: a coding agent to fix something, a brain's agent to work with its memory. It gets a card of its own (on the board you name, or Fleet), works through it and leaves its answer there; with a board that is a project, it works in that project's repo and its commits come back as the branch fleet/<id>. spawn_status lists the templates and where they run. It may wait for room on the machine; it doesn't wait for you.",
    properties: {
      template: str("A template's name, from spawn_status"),
      task: str("What the agent should do, in full: it knows only this and its repo"),
      environment: str("Where to run it; the first that has the template, if left out"),
      board: str("The board's key, from list_boards: its card goes there, and a project board's repo is what it works in"),
    },
    required: ["template", "task"],
    user: true,
    run: async (a, c) => spawn(c.env, c.user, "user", a),
  },
  start_session: {
    description:
      "Start a Claude Code session in a VM of its own, for the user to talk to from their phone or the fleet view, rather than an agent on a task: it runs until stopped (spawn_stop), and its commits come back as the branch fleet/<id>. It gets a card on the board you name. spawn_status lists the templates (VM types) and where they run.",
    properties: {
      template: str("A template's name, from spawn_status: the VM type"),
      board: str("The board's key, from list_boards: its project's repo is what the session works in"),
      environment: str("Where to run it; the first that has the template, if left out"),
      message: str("What to say to it first, if anything"),
    },
    required: ["template", "board"],
    user: true,
    run: async (a, c) => spawn(c.env, c.user, "user", { template: a.template, board: a.board, environment: a.environment, task: a.message ?? "", interactive: true }),
  },
  spawn_status: {
    description: "One spawned agent: its state, its card, and its answer when done. Without an id, the newest spawns, and the templates each environment can run.",
    properties: { id: str("The spawn's id") },
    user: true,
    run: async (a, c) => status(c.env, c.user, a.id ? String(a.id) : undefined),
  },
  spawn_stop: {
    description: "Stop a spawned agent: before it runs it never will; while it runs its VM is stopped.",
    properties: { id: str("The spawn's id") },
    required: ["id"],
    user: true,
    run: async (a, c) => stop(c.env, c.user, String(a.id)),
  },
};

// What a grant sees: a card token its board's tools, with no board argument;
// an OAuth client or Pepper every tool with one, list_boards, and the user's
// tools, whose note kinds are only those it can see.
function toolsFor(grant: Grant) {
  const ownKinds = (properties: Record<string, object>) =>
    Object.fromEntries(Object.entries(properties).map(([k, p]) => [k, "enum" in p && p.enum === NOTE_KINDS ? { ...p, enum: kinds(grant) } : p]));
  const tools = Object.entries(TOOLS)
    .filter(([, t]) => grant.kind !== "card" || t.card)
    .map(([name, t]) => {
      const properties = grant.kind === "card" ? (t.properties ?? {}) : { board: str("The board's key, from list_boards"), ...t.properties };
      const required = grant.kind === "card" ? (t.required ?? []) : ["board", ...(t.required ?? [])];
      return { name, description: t.description, inputSchema: { type: "object", properties, required } };
    });
  if (grant.kind !== "card") {
    tools.unshift(
      {
        name: "list_boards",
        description: "List the boards: their keys (for every other tool's board argument), names and project paths.",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "create_board",
        description:
          "Make a new board. With root (a project's absolute path on the user's machine) it's that project's board, the one corkboard shows there; without one it's a board of its own, for work that isn't in a repository. Returns its key, for every other tool's board argument.",
        inputSchema: {
          type: "object",
          properties: { name: str("What it's called, one line"), root: str("The project's absolute path, like /home/matthew/corkboard") },
          required: ["name"],
        },
      },
    );
    for (const [name, t] of Object.entries(USER_TOOLS).filter(([, t]) => reaches(t, grant)))
      tools.push({ name, description: t.description, inputSchema: { type: "object", properties: ownKinds(t.properties ?? {}), required: t.required ?? [] } });
  }
  return tools;
}

// The key is the one corkboard looks for: a project's path with / as -
// (util.path_key), or for a board with no project, its name as a slug. An
// existing board is refused, not renamed: renaming is the user's (PUT).
async function createBoard(env: Env, user: string, a: any) {
  if (typeof a.name !== "string" || !a.name.trim()) throw new ToolError("give the board a name");
  const name = a.name.trim().slice(0, 200);
  let root: string | null = null;
  if (a.root !== undefined && a.root !== null && a.root !== "") {
    root = String(a.root).trim().replace(/\/+$/, "");
    if (!root.startsWith("/") || root.split("/").includes("..")) throw new ToolError("root must be an absolute path");
  }
  const key = root ? root.replace(/^\//, "").replace(/\//g, "-") : slug(name);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new ToolError(`can't make a board key from ${root ?? name}`);
  const users = env.USER.get(env.USER.idFromName(user));
  const was = (await users.boards()).find((b) => b.key === key);
  if (was) throw new ToolError(`there's already a board ${key}, ${was.name}`);
  const info = { key, name, root };
  await env.BOARD.get(env.BOARD.idFromName(`${user}/${key}`)).describe(name, root);
  await users.remember(info);
  return info;
}

async function callTool(env: Env, user: string, grant: Grant, name: string, args: any): Promise<unknown> {
  if (name === "list_boards" && grant.kind !== "card") return env.USER.get(env.USER.idFromName(user)).boards();
  if (name === "create_board" && grant.kind !== "card") return createBoard(env, user, args);
  if (USER_TOOLS[name] && reaches(USER_TOOLS[name], grant)) {
    try {
      const memory = await memoryOf(env, user, brainOf(grant)!);
      return await USER_TOOLS[name].run({ ...args }, { env, user, users: env.USER.get(env.USER.idFromName(user)), memory, grant, timeZone: env.TIMEZONE });
    } catch (e) {
      if (e instanceof Invalid || e instanceof Refused) throw new ToolError(e.message);
      throw e;
    }
  }
  const tool = TOOLS[name];
  if (!tool || (grant.kind === "card" && !tool.card)) throw new ToolError(`unknown tool ${name}`);
  const key = grant.kind === "card" ? grant.board : String(args.board ?? "");
  if (!key) throw new ToolError("say which board, from list_boards");
  const board = env.BOARD.get(env.BOARD.idFromName(`${user}/${key}`)) as unknown as Stub;
  if (args.id !== undefined) args.id = String(args.id).toUpperCase();
  if (grant.kind === "card" && tool.card === "own" && args.id !== grant.card)
    throw new ToolError(`this session works on ${grant.card}; it can read other cards but not change them`);
  // Any call from the agent holding a card keeps its claim (board.ts's
  // leases): a card agent's for its card, anyone else's for the card named.
  // A card that's gone or not theirs is the tool's to report, not this.
  const heard = grant.kind === "card" ? grant.card : args.id;
  if (typeof heard === "string") await board.touch(heard, grant.agent);
  if (!HOLD_ALLOWS.has(name) && typeof args.id === "string") {
    const { extra } = unwrap(await board.get(args.id));
    if (extra.budget_hold)
      throw new ToolError(
        `budget reached on ${args.id}: ${extra.budget_hold}. Stop working on it and wait; the user has been told and will answer on the card.`,
      );
  }
  let listed: Card[] | undefined;
  const cards = async () => (listed ??= unwrap(await board.list()));
  try {
    return await tool.run(args, { env, user, board, key, me: grant.agent, grant, cards });
  } catch (e) {
    if (e instanceof MediaError) throw new ToolError(e.message);
    throw e;
  }
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
