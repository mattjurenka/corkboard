// The node's /mcp: the Worker's MCP tools (its mcp.ts) for cards,
// notes and memory, over the node's replicas instead of its Durable Objects.
// Same names, descriptions and rules, so a client moved from the Worker to
// the node sees the same tools, less those with nothing on the node yet:
// boards made over MCP, day plans and the chat. The fleet's spawn tools
// queue on the Worker (Fleet), signed in to it.
//
// Streamable HTTP, stateless, as the Worker's: each POST is a JSON-RPC
// message (or a batch) answered with JSON; GET is 405. Every tool here
// answers from local state at once, so there's no long call to keep alive.
//
// Every caller is the user's own client: an OAuth token's scope says which
// (owner or assistant, oauth.ts). An assistant can't write the soul, and
// neither sees the brains' goals, as on the Worker. Or it's held to one board
// (oauth.ts's card and session grants), whose tools take no board argument:
// a card's agent changes only its own card, and a fleet session only reads
// its board and makes cards (SESSION_TOOLS). Neither has memory tools here.

import { AGENT_STATES, type Card, PRIORITIES, STATUSES, waitingOn } from "../../lib/model/cards";
import { BRAIN_ONLY_KINDS, NOTE_KINDS, OWNER_ONLY_NOTES, chatText, date, note, noteId, projects, proposal, slug } from "../../lib/model/plans";
import { DAY } from "./objects";
import { range } from "../../lib/model/dates";
import { Conflict, type Data, type FullCard, Invalid } from "./data";
import type { Search } from "./search";
import { touch } from "./leases";
import { MAX_INLINE, type Media, fileName, fileType } from "./media";
import { type Kind, boardBound } from "./oauth";

export type Caller = { scope: Kind; agent: string; brain?: string; board?: string; card?: string };

class ToolError extends Error {}

type Draft = FullCard & { logs: string[] };
const FIELDS = ["title", "status", "agent", "agent_state", "attention", "priority", "ordinal", "labels", "dependencies", "description"] as const;

// origin: where the call came in, which an upload's URL is at.
type Call = { data: Data; search: Search; media?: Media; origin: string; board: string; me: string; caller: Caller; cards: () => FullCard[] };

// Read a card, change a draft of it, write what changed and its log
// entries. A replica merges per field, so there's no version to retry on.
async function change(c: Call, id: string, fn: (d: Draft) => void): Promise<Card> {
  const current = c.data.card(c.board, id);
  const draft: Draft = { ...structuredClone(current), logs: [] };
  fn(draft);
  const fields: Record<string, unknown> = {};
  for (const k of FIELDS) if (JSON.stringify(draft[k]) !== JSON.stringify(current[k])) fields[k] = draft[k];
  let written: Card = current;
  if (Object.keys(fields).length) written = await c.data.updateCard(c.board, id, fields);
  for (const n of draft.logs) await c.data.appendLog(c.board, id, c.me, n);
  return written;
}

const logText = (log: FullCard["log"]) => log.map((e) => `- ${e.at} ${e.who}: ${e.note.replace(/\n/g, "\n  ")}`).join("\n");

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

function full(c: FullCard) {
  const { log, extra, version: _, ...fields } = c;
  return { ...extra, ...fields, log: logText(log) };
}

// card: whether a card's agent may call it, and on which card: "own" checks
// that the id argument is its card.
type Tool = { description: string; properties?: Record<string, object>; required?: string[]; card?: "any" | "own"; run: (a: any, c: Call) => Promise<unknown> | unknown };

const str = (description: string) => ({ type: "string", description });
const id = str("Card id, e.g. TASK-4");
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const labels = strings("Labels, replacing the card's");
const dependencies = strings("Ids of cards this one waits on, e.g. TASK-4; replaces the card's");
const priority = { type: "string", enum: [...PRIORITIES, ""], description: "high, medium or low; empty clears it, which counts as medium" };
function priorityOf(v: unknown) {
  if (v === "" || v === null) return null;
  if (!PRIORITIES.includes(v as (typeof PRIORITIES)[number])) throw new ToolError(`priority must be one of ${PRIORITIES.join(", ")}`);
  return v as (typeof PRIORITIES)[number];
}
const cleanList = (v: unknown) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : []);
const oneLine = (s: unknown) => String(s).replace(/\n/g, " ").trim();

function holder(card: Card, me: string) {
  if (card.agent !== me) throw new ToolError(`card ${card.id} is held by ${card.agent || "nobody"}, not ${me}; claim it first`);
  if (card.agent_state === "queued") throw new ToolError(`card ${card.id} is queued for you; claim it first`);
}

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
  const cards = c.cards();
  return change(c, cardId, (card) => {
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

const read = (c: Call, cardId: string) => full(c.data.card(c.board, cardId));
const brief = (c: Call, card: Card) => summary(card, c.cards());
const HANDED_OFF = "Handed off. End your turn now: this session will be cleared and the next started from your handoff.";

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
    run: (a, c) => {
      const cards = c.cards();
      const rank = (x: Card) => ({ high: 0, medium: 1, low: 2 })[x.priority ?? "medium"];
      return cards
        .filter((x) => !a.status || x.status === a.status)
        .filter((x) => !a.agent_state || x.agent_state === a.agent_state)
        .filter((x) => !a.agent || x.agent === a.agent)
        .filter((x) => !a.mine || x.agent === c.me)
        .sort((x, y) => rank(x) - rank(y) || (x.ordinal ?? Infinity) - (y.ordinal ?? Infinity) || x.id.localeCompare(y.id, undefined, { numeric: true }))
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
      const cards = c.cards();
      const candidates = [...cards.filter((x) => x.agent === c.me && x.agent_state === "queued"), ...cards.filter((x) => x.status === "ready" && !x.agent)].filter(
        // A card's agent works on its own card and nothing else.
        (x) => !waitingOn(x, cards).length && !x.extra.budget_hold && (c.caller.scope !== "card" || x.id === c.caller.card),
      );
      for (const x of candidates) {
        try {
          return read(c, (await claim(c, x.id)).id);
        } catch {}
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
    description: "Give up a card you hold without finishing it; it goes back to ready, unassigned. Use it when the user puts the card off for later.",
    properties: { id, note: str("Why you are letting it go") },
    required: ["id", "note"],
    card: "own",
    run: async (a, c) =>
      brief(
        c,
        await change(c, a.id, (x) => {
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
    run: async (a, c) => brief(c, await change(c, a.id, (x) => x.logs.push(String(a.note).trim()))),
  },
  block: {
    description:
      "You need a human decision: marks the card blocked, logs your question and sends the user a desktop notification. Stop working on it until it is answered.",
    properties: { id, question: str("What you need decided, with the options you see. The first line is the notification.") },
    required: ["id", "question"],
    card: "own",
    run: async (a, c) => brief(c, await change(c, a.id, (x) => ask(x, c.me, String(a.question), true))),
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
    run: async (a, c) => brief(c, await change(c, a.id, (x) => ask(x, c.me, String(a.message), a.wait !== false))),
  },
  submit_for_review: {
    description: "You finished a card: moves it to review. The user reads your summary to decide whether to merge, so keep it short and plain; the diff shows the details.",
    properties: { id, summary: str("What changed, in a few short sentences or bullets. Name anything the user has to do or decide."), verification: str("How you checked it works, in a sentence or two, and what you couldn't check") },
    required: ["id", "summary", "verification"],
    card: "own",
    run: async (a, c) =>
      brief(
        c,
        await change(c, a.id, (x) => {
          holder(x, c.me);
          x.status = "review";
          x.agent_state = "needs-review";
          x.attention = null;
          x.logs.push(`${a.summary}\nVerified: ${a.verification}`);
        }),
      ),
  },
  handoff: {
    description:
      "Hand your work to a fresh session when your context is nearly full: the goal, what's done and verified, what's left, and what you learned that the next session would otherwise have to find again. On a card, it goes in the card's log. Then end your turn.",
    properties: { id: str("The card you're on, if any"), text: str("The handoff, markdown") },
    required: ["text"],
    card: "own",
    run: async (a, c) => {
      await c.data.appendLog(c.board, a.id, c.me, `handoff:\n${String(a.text).trim()}`);
      return HANDED_OFF;
    },
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
        await change(c, a.id, (x) => {
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
      if (!c.media) throw new ToolError("this node doesn't keep files");
      const name = fileName(a.name);
      const type = fileType(name, a.type);
      if (a.data === undefined || a.data === null || a.data === "") {
        const { url, expires_at } = c.media.offer(c.origin, c.board, a.id, c.me, name, type);
        return { upload: url, expires_at, command: `curl -fsS -T <path to ${name}> ${url}` };
      }
      if (typeof a.data !== "string" || a.data.length > (MAX_INLINE * 4) / 3 + 4) throw new ToolError("data is base64 under 4 MB; upload a larger file with curl");
      const clean = a.data.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new ToolError("data must be base64");
      return c.media.attach(c.board, a.id, c.me, name, type, new Uint8Array(Buffer.from(clean, "base64")));
    },
  },
  archive_card: {
    description:
      "Take a card off the board: it leaves the board and list_cards but is kept, and read_card still reads it. For cards that are finished with or no longer wanted. It must not be held by an agent at work.",
    properties: { id, note: str("Why it's being archived; goes in its log") },
    required: ["id", "note"],
    run: async (a, c) => {
      const card = c.data.card(c.board, a.id);
      if (card.agent && card.agent_state && ["queued", "working", "blocked"].includes(card.agent_state))
        throw new ToolError(`card ${a.id} is ${card.agent_state} with ${card.agent}; release it first`);
      await c.data.appendLog(c.board, a.id, c.me, `archived: ${String(a.note).trim()}`);
      return brief(c, await c.data.archive(c.board, a.id, true));
    },
  },
  write_description: {
    description: "Replace a card's description. Its log is kept as it is; add to the log with the log tool.",
    properties: { id, description: str("The new description, markdown") },
    required: ["id", "description"],
    card: "own",
    run: async (a, c) => brief(c, await change(c, a.id, (x) => (x.description = String(a.description).trim()))),
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
      if (parent && c.caller.scope === "card" && parent !== c.caller.card) throw new ToolError(`you can only make follow-ups of your own card, ${c.caller.card}`);
      // A card's agent asks about its own card (block, request_user_action);
      // this is for Pepper and other clients, which hold no card.
      if (a.attention !== undefined && c.caller.scope === "card") throw new ToolError("ask about your own card with request_user_action");
      if (parent) c.data.card(c.board, parent);
      if (a.status !== undefined && !STATUSES.includes(a.status)) throw new ToolError(`status must be one of ${STATUSES.join(", ")}`);
      const title = oneLine(a.title ?? "");
      if (!title) throw new ToolError("a card needs a title");
      const attention = typeof a.attention === "string" ? oneLine(a.attention) : "";
      const card = await c.data.createCard(c.board, {
        title,
        description: typeof a.description === "string" ? a.description.trim() : "",
        status: a.status ?? "backlog",
        priority: a.priority === undefined ? null : priorityOf(a.priority),
        labels: cleanList(a.labels),
        dependencies: cleanList(a.dependencies).map((d) => d.toUpperCase()),
        ...(attention ? { attention: attention.length > 200 ? attention.slice(0, 199) + "…" : attention } : {}),
      });
      if (parent) {
        await c.data.appendLog(c.board, parent, c.me, `follow-up: ${card.id}`);
        await c.data.appendLog(c.board, card.id, c.me, `created from ${parent}`);
      }
      return brief(c, card);
    },
  },
};

const INSTRUCTIONS = (me: string) => `The corkboard project board: one card per task. You are "${me}".
To pick up work, call next_card (or claim_card for a specific card). While working, log progress with log.
If you need a human decision, call block with your question and stop. If you need the user to do something
(log in, approve, test on a device), call request_user_action; both notify them on their desktop.
When done, call submit_for_review.
Put follow-up work you discover in new cards with create_card (parent: the card you are on).
If the user puts a card off for later ("do it tomorrow", "push this"), call release_card so it goes back to ready.`;
const MEMORY_INSTRUCTIONS = "Your memory, kept encrypted on the user's machines: notes, a log by day, and recall across them. The session started with memory_context; memory_recall finds the rest.";

// The fleet -----------------------------------------------------------------------------

// The Worker's fleet queue (its /api/spawns and /api/fleet), as the user
// signed in to it; it throws the Worker's error.
export type Fleet = (method: string, path: string, body?: unknown) => Promise<any>;

type FleetCall = { data: Data; fleet: Fleet; me: string };
type FleetTool = { description: string; properties?: Record<string, object>; required?: string[]; run: (a: any, c: FleetCall) => Promise<unknown> };

// What a spawn brings to its VM: its tools, and its size.
const VM = {
  packages: strings("nixpkgs attribute names to have, e.g. nodejs_22, postgresql"),
  shell: str('A flake ref whose devShell it runs in, e.g. github:me/envs#rust, or ".#" for its repo\'s own'),
  needs: strings("Capabilities its VM must have (spawn_status lists them), e.g. gpu"),
  memory: { type: "integer", description: "MiB of RAM, if it needs more than its template's" },
  cores: { type: "integer", description: "vCPUs, if it needs more than its template's" },
};

// A spawn on one of the node's boards is queued on the Worker with the
// board's key and card's id alone (node: true); the card is checked and
// marked here, as the Worker marks its own boards' (its fleet.ts's spawn),
// and fleetd writes how it goes. Any other board is still the Worker's.
async function queue(c: FleetCall, a: Record<string, unknown>) {
  const board = typeof a.board === "string" && a.board ? a.board : null;
  if (!board || !c.data.replicas.get("board", board)) return c.fleet("POST", "/spawns", a);
  const id = typeof a.card === "string" && a.card ? a.card.toUpperCase() : null;
  if (id) {
    const card = c.data.card(board, id);
    if (card.archived) throw new ToolError(`${id} is archived`);
    if (card.agent && card.agent_state && card.agent_state !== "done") throw new ToolError(`${id} is ${card.agent_state} with ${card.agent}`);
  }
  const s = await c.fleet("POST", "/spawns", { ...a, board, ...(id && { card: id }), node: true });
  if (!id) return s;
  const what = `${s.template}${s.brain ? ` for the ${s.brain} brain` : ""}`;
  const shell = s.shell ? `, with ${"flake" in s.shell ? s.shell.flake : s.shell.packages.join(" ")}` : "";
  await c.data.updateCard(board, id, {
    agent: s.agent,
    agent_state: "queued",
    ...(s.state === "pending-approval" && { attention: `approve: ${c.me} wants to spawn ${what}` }),
  });
  await c.data.appendLog(board, id, "fleet", `spawned ${s.id}: ${what} in ${s.environment}${shell}, asked by ${c.me}`);
  return s;
}

// The Worker's spawn tools, with the same names and descriptions.
const FLEET_TOOLS: Record<string, FleetTool> = {
  spawn_agent: {
    description:
      "Start an agent on a task, in a VM of its own: a coding agent to fix something, a brain's agent to work with its memory. It makes no card: its state and answer are in spawn_status. Name a card (and its board) and it works on that card, leaving its answer there; name only a board and it can read it and make cards for work worth tracking. With a board that is a project, it works in that project's repo and its commits come back as the branch fleet/<id>. spawn_status lists the templates and where they run. Bring its tools with packages or shell (built inside its VM), and size it with memory and cores, within what its machine offers. It may wait for room on the machine; it doesn't wait for you.",
    properties: {
      template: str("A template's name, from spawn_status: the VM type; left out, the smallest one that has every need"),
      brain: str("The brain it works for, from spawn_status: it starts with the brain's memory and runs as its account; left out, none"),
      task: str("What the agent should do, in full: it knows only this and its repo"),
      environment: str("Where to run it; the first that has the template, if left out"),
      board: str("The board's key, from list_boards: a project board's repo is what it works in"),
      card: str("A card on board for it to work on, e.g. TASK-4; left out, none"),
      ...VM,
    },
    required: ["task"],
    run: (a, c) => queue(c, a),
  },
  start_session: {
    description:
      "Start a Claude Code session in a VM of its own, for the user to talk to from their phone or the fleet view, rather than an agent on a task: it runs until stopped (spawn_stop), and its commits come back as the branch fleet/<id>. It gets no card; it can make one on its board when its work is worth tracking. spawn_status lists the templates (VM types) and where they run.",
    properties: {
      template: str("A template's name, from spawn_status: the VM type; left out, the smallest one that has every need"),
      brain: str("The brain it works for, from spawn_status: it starts with the brain's memory and runs as its account; left out, none"),
      board: str("The board's key, from list_boards: its project's repo is what the session works in"),
      environment: str("Where to run it; the first that has the template, if left out"),
      message: str("What to say to it first, if anything"),
      ...VM,
    },
    required: ["board"],
    run: (a, c) => {
      const { message, card: _, ...rest } = a;
      return queue(c, { ...rest, task: message ?? "", interactive: true });
    },
  },
  spawn_status: {
    description: "One spawned agent: its state, its card (a session has none), and its answer when done. Without an id, the newest spawns, and the templates each environment can run.",
    properties: { id: str("The spawn's id") },
    run: (a, c) => c.fleet("GET", `/fleet/status${a.id ? `?id=${encodeURIComponent(String(a.id))}` : ""}`),
  },
  spawn_stop: {
    description: "Stop a spawned agent: before it runs it never will; while it runs its VM is stopped.",
    properties: { id: str("The spawn's id") },
    required: ["id"],
    run: (a, c) => c.fleet("POST", `/spawns/${encodeURIComponent(String(a.id))}/stop`),
  },
};

// The user's own clients spawn, as on the Worker: not a brain's token, nor
// one held to a board.
const spawns = (caller: Caller, fleet?: Fleet) => !!fleet && (caller.scope === "owner" || caller.scope === "assistant") && !caller.brain;

// Memory --------------------------------------------------------------------------------

type MemoryCall = { data: Data; search: Search; brain: string; caller: Caller; hidden: readonly string[] };
type MemoryTool = { description: string; properties?: Record<string, object>; required?: string[]; run: (a: any, c: MemoryCall) => Promise<unknown> | unknown };

const kinds = (hidden: readonly string[]) => NOTE_KINDS.filter((k) => !hidden.includes(k));

function visible(id: string, c: MemoryCall) {
  const n = c.data.note(c.brain, id);
  if (!n || c.hidden.includes(n.kind)) throw new ToolError(`no note ${id}`);
  return n;
}

function writable(id: string, c: MemoryCall) {
  if (OWNER_ONLY_NOTES.has(id) && c.caller.scope !== "owner") throw new ToolError(`only the user writes the ${id} note`);
}

const MEMORY_TOOLS: Record<string, MemoryTool> = {
  notes_search: {
    description:
      "Search your notes: day records, decisions, projects, people, reviews, memory, drafts, and whatever else kind lists. With no query, the newest. Every word must match.",
    properties: { query: str("Words to find"), kind: { type: "string", enum: NOTE_KINDS }, limit: { type: "integer", description: "At most this many (default 20)" } },
    run: (a, c) => c.search.notes(c.brain, a.query ? String(a.query) : undefined, a.kind, Math.min(Number(a.limit) || 20, 100), c.hidden),
  },
  note_read: {
    description: "Read a note.",
    properties: { id: str("The note's id") },
    required: ["id"],
    run: (a, c) => visible(noteId(String(a.id)), c),
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
      writable(id, c);
      if (c.hidden.includes(a.kind)) throw new ToolError(`kind must be one of ${kinds(c.hidden).join(", ")}`);
      const was = c.data.note(c.brain, id);
      if (was && c.hidden.includes(was.kind)) throw new ToolError(`the id ${id} is taken; choose another`);
      if (a.version !== undefined && (!Number.isInteger(a.version) || a.version < 0)) throw new ToolError("version must be the note's version, from note_read");
      return c.data.putNote(c.brain, id, note(a), a.version);
    },
  },
  note_append: {
    description: "Add a timestamped line to a note, such as today's day record, without rewriting it.",
    properties: { id: str("The note's id"), text: str("What to add") },
    required: ["id", "text"],
    run: async (a, c) => {
      const id = noteId(String(a.id));
      writable(id, c);
      visible(id, c);
      if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("say what to add");
      return c.data.appendNote(c.brain, id, c.caller.agent, a.text);
    },
  },
  memory_context: {
    description:
      "What you start a session with: who you are and who the user is, the last few days' log and day records, and what you've learned. Your session start hook already loads it; call this after a long session to see it again.",
    properties: { budget: { type: "integer", description: "At most this many characters (default 24000)" } },
    run: (a, c) => c.search.context(c.brain, Math.min(Math.max(Number(a.budget) || 24_000, 1000), 200_000), c.hidden),
  },
  memory_recall: {
    description:
      "Search everything you remember, notes and log alike, for any of the words; the best matches first, each with a snippet. Read a whole note with note_read.",
    properties: { query: str("What you're trying to remember, in words it would be written in"), limit: { type: "integer", description: "At most this many (default 15)" } },
    required: ["query"],
    run: (a, c) => {
      if (typeof a.query !== "string" || !a.query.trim()) throw new ToolError("say what to recall");
      return c.search.recall(c.brain, a.query, Math.min(Number(a.limit) || 15, 50), c.hidden);
    },
  },
  memory_remember: {
    description:
      "Write a line in today's log: something that happened, was decided or was learned, in a sentence or two that will make sense on its own later. Every agent of yours shares the log.",
    properties: { text: str("What to remember") },
    required: ["text"],
    run: (a, c) => {
      if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("say what to remember");
      if (a.text.length > 4000) throw new ToolError("keep it under 4000 characters; a longer record is a note");
      return c.data.remember(c.brain, c.caller.agent, a.text);
    },
  },
  memory_log: {
    description:
      'The log for some days, oldest first: when as words ("yesterday", "last week", "last Tuesday", "Oct 24", "3 days ago") or from and to as YYYY-MM-DD. The dates are worked out for you; don\'t do date arithmetic yourself.',
    properties: { when: str("Which days, in words"), from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD; from, if left out") },
    run: (a, c) => {
      let from: string, to: string;
      if (a.from) [from, to] = [date(a.from), a.to ? date(a.to) : date(a.from)];
      else {
        const r = range(String(a.when ?? "today"), c.data.today());
        if (!r) throw new ToolError(`can't tell which days "${a.when}" means; say from and to`);
        [from, to] = [r.from, r.to];
      }
      if (to < from) throw new ToolError("to is before from");
      return { from, to, entries: c.data.entries(c.brain, from, to) };
    },
  },
  memory_grep: {
    description: "Every line in your notes and log that contains this text, case ignored, newest notes first. For when you know the exact words.",
    properties: { text: str("The text to find"), limit: { type: "integer", description: "At most this many lines (default 50)" } },
    required: ["text"],
    run: (a, c) => {
      if (typeof a.text !== "string" || !a.text.trim()) throw new ToolError("say what to find");
      return c.search.grep(c.brain, a.text.trim(), Math.min(Number(a.limit) || 50, 200), c.hidden);
    },
  },
  brain_list: {
    description: "The brains: who agents work for, each with its memory. One is the default, which your own sessions remember in.",
    run: (_a, c) => c.data.brains().map((b) => ({ ...b, default: b.name === c.data.defaultBrain() })),
  },
  brain_read: {
    description: "One brain: its record, and its memory's counts (notes, entries).",
    properties: { name: str("The brain's name") },
    required: ["name"],
    run: (a, c) => {
      const name = String(a.name);
      if (!c.data.brains().some((b) => b.name === name)) throw new ToolError(`no brain ${name}; brain_list lists them`);
      return { ...c.data.brain(name), memory: { notes: c.data.notes(name).length, entries: c.data.entries(name).length } };
    },
  },
};

// Day plans and the chat (day.ts) ------------------------------------------------------

type DayCall = { data: Data; caller: Caller };
// ability: only for a brain whose abilities have it; to anyone else the
// tool doesn't exist.
type DayTool = { description: string; properties?: Record<string, object>; required?: string[]; ability?: "chat"; run: (a: any, c: DayCall) => Promise<unknown> | unknown };

const day = str("YYYY-MM-DD; today, where the user is, if left out");
const lineList = (description: string) => ({ type: "array", items: { type: "object" }, description });
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

const DAY_TOOLS: Record<string, DayTool> = {
  plan_read: {
    description:
      "Read a day's plan: the day as accepted (its blocks, the ranked work, what's not today), any proposal waiting for the user, and asked: what the user has said to change since your last proposal.",
    properties: { date: day },
    run: (a, c) => c.data.plan(a.date ? date(a.date) : c.data.today()),
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
    run: (a, c) => {
      const { answering: _, ...made } = proposal(a, c.caller.agent, []);
      return c.data.propose(a.date ? date(a.date) : c.data.today(), made, a.projects === undefined ? undefined : projects(a.projects));
    },
  },
  chat_read: {
    description:
      "Read your chat with the user, oldest first: what they said to you from their phone and what you answered. after: only messages after this id; without it, the newest 100.",
    properties: { after: str("A message id") },
    ability: "chat",
    run: (a, c) => c.data.chat(a.after ? String(a.after) : undefined, 100),
  },
  chat_send: {
    description: "Say something to the user in your chat; it reaches their phone at once. Plain text, no markdown.",
    properties: { text: str("What to say") },
    required: ["text"],
    ability: "chat",
    run: (a, c) => c.data.post(c.caller.brain ?? "assistant", chatText(a.text)),
  },
};

// Not to one held to a board, nor with no day object; a tool of an
// ability, only to a brain that has it (its settings, read each call).
function dayReaches(t: DayTool, caller: Caller, data: Data) {
  if (boardBound(caller) || !data.replicas.get("day", DAY)) return false;
  if (!t.ability) return true;
  if (!caller.brain || !data.replicas.get("brain", caller.brain)) return false;
  const abilities = data.brain(caller.brain).abilities;
  return Array.isArray(abilities) && abilities.includes(t.ability);
}

// Tools and calls ------------------------------------------------------------------------

// A fleet session's (oauth.ts's session grants): it has no card of its own,
// so it reads its board and makes a card once its work is worth tracking.
const SESSION_TOOLS = new Set(["list_cards", "read_card", "create_card", "handoff"]);

const reaches = (name: string, caller: Caller) => (caller.scope === "session" ? SESSION_TOOLS.has(name) : caller.scope !== "card" || !!TOOLS[name]?.card);

// memoryOnly: the memory tools alone, for a local session (app.ts), whose
// board tools are its own board's. One held to a board, that board's tools
// it reaches, with no board argument.
function toolsFor(data: Data, caller: Caller, hidden: readonly string[], memoryOnly = false, fleet?: Fleet) {
  if (boardBound(caller))
    return Object.entries(memoryOnly ? {} : TOOLS)
      .filter(([name]) => reaches(name, caller))
      .map(([name, t]) => ({ name, description: t.description, inputSchema: { type: "object", properties: t.properties ?? {}, required: t.required ?? [] } }));
  const ownKinds = (properties: Record<string, object>) =>
    Object.fromEntries(Object.entries(properties).map(([k, p]) => [k, "enum" in p && p.enum === NOTE_KINDS ? { ...p, enum: kinds(hidden) } : p]));
  const memory = Object.entries(MEMORY_TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    inputSchema: { type: "object", properties: ownKinds(t.properties ?? {}), required: t.required ?? [] },
  }));
  if (memoryOnly) return memory;
  return [
    {
      name: "list_boards",
      description: "List the boards: their keys (for every other tool's board argument), names and project paths.",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    ...Object.entries(TOOLS).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: { type: "object", properties: { board: str("The board's key, from list_boards"), ...t.properties }, required: ["board", ...(t.required ?? [])] },
    })),
    ...memory,
    ...Object.entries(DAY_TOOLS)
      .filter(([, t]) => dayReaches(t, caller, data))
      .map(([name, t]) => ({ name, description: t.description, inputSchema: { type: "object", properties: t.properties ?? {}, required: t.required ?? [] } })),
    ...Object.entries(spawns(caller, fleet) ? FLEET_TOOLS : {}).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: { type: "object", properties: t.properties ?? {}, required: t.required ?? [] },
    })),
  ];
}

export type Node = { data: Data; search: Search; media?: Media; origin: string; fleet?: Fleet };

async function callTool(node: Node, caller: Caller, name: string, args: any): Promise<unknown> {
  const { data, search, media, origin } = node;
  const bound = boardBound(caller);
  if (name === "list_boards" && !bound) return data.boards();
  if (FLEET_TOOLS[name] && spawns(caller, node.fleet))
    return FLEET_TOOLS[name].run({ ...args }, { data, fleet: node.fleet!, me: caller.agent }).catch((e) => {
      throw e instanceof Invalid || e instanceof ToolError ? e : new ToolError((e as Error).message);
    });
  if (DAY_TOOLS[name] && dayReaches(DAY_TOOLS[name], caller, data)) return DAY_TOOLS[name].run({ ...args }, { data, caller });
  // A brain's own agent sees its goals; the user's clients don't.
  const hidden = caller.brain ? [] : BRAIN_ONLY_KINDS;
  if (MEMORY_TOOLS[name] && !bound) {
    const brain = caller.brain ?? data.defaultBrain();
    if (!brain || !data.replicas.get("brain", brain)) throw new ToolError(caller.brain ? `no brain ${brain} on this node` : "there's no brain on this node to remember in; start it with --brain NAME");
    return MEMORY_TOOLS[name].run({ ...args }, { data, search, brain, caller, hidden });
  }
  // A handoff off any card is the session's alone, for corkboard to start
  // the next one from.
  if (name === "handoff" && args.id === undefined) {
    if (caller.scope !== "card") return HANDED_OFF;
    args.id = caller.card;
  }
  const tool = TOOLS[name];
  if (!tool || !reaches(name, caller)) throw new ToolError(`unknown tool ${name}`);
  const board = bound ? caller.board! : String(args.board ?? "");
  if (!board) throw new ToolError("say which board, from list_boards");
  if (!data.replicas.get("board", board)) throw new ToolError(bound ? `no board ${board} on this node` : `no board ${board}; list_boards lists them`);
  if (args.id !== undefined) args.id = String(args.id).toUpperCase();
  if (caller.scope === "card" && tool.card === "own" && args.id !== caller.card)
    throw new ToolError(`this session works on ${caller.card}; it can read other cards but not change them`);
  // Any call from the agent holding a card keeps its claim (leases.ts): a
  // card agent's for its card, anyone else's for the card named; and after
  // a claim, the one it made. A card that's gone is the tool's to report.
  const heard = caller.scope === "card" ? caller.card : args.id;
  const hear = async () => (typeof heard === "string" && data.cards(board, true).some((c) => c.id === heard) ? touch(data, board, heard, caller.agent) : null);
  const held = await hear();
  if (!["read_card", "block", "request_user_action", "release_card"].includes(name) && typeof args.id === "string") {
    const extra = data.card(board, args.id).extra;
    if (extra.budget_hold)
      throw new ToolError(`budget reached on ${args.id}: ${extra.budget_hold}. Stop working on it and wait; the user has been told and will answer on the card.`);
  }
  let listed: FullCard[] | undefined;
  const out = await tool.run(args, { data, search, media, origin, board, me: caller.agent, caller, cards: () => (listed ??= data.cards(board)) });
  if (!held) await hear();
  return out;
}

type Message = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };

// boardOnly: the rest, for a local session's corkboard server once its
// boards are the node's (app.ts), beside corkboard-memory.
async function handle(node: Node, caller: Caller, msg: Message, memoryOnly: boolean, boardOnly = false): Promise<object | undefined> {
  const { id, method, params } = msg ?? {};
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "corkboard-node", version: "0.1.0" },
        instructions: memoryOnly ? MEMORY_INSTRUCTIONS : INSTRUCTIONS(caller.agent),
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolsFor(node.data, caller, BRAIN_ONLY_KINDS, memoryOnly, node.fleet).filter((t) => !boardOnly || !MEMORY_TOOLS[t.name]) });
    case "tools/call":
      try {
        const name = String(params?.name);
        if ((memoryOnly && !MEMORY_TOOLS[name]) || (boardOnly && MEMORY_TOOLS[name])) throw new ToolError(`unknown tool ${name}`);
        const out = await callTool(node, caller, name, { ...(params?.arguments ?? {}) });
        return reply({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        if (e instanceof ToolError || e instanceof Invalid || e instanceof Conflict) return reply({ content: [{ type: "text", text: e.message }], isError: true });
        throw e;
      }
    default:
      return id === undefined ? undefined : { jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: `unknown method ${method}` } };
  }
}

export async function mcp(request: Request, node: Node, caller: Caller): Promise<Response> {
  if (request.method !== "POST") return new Response("POST JSON-RPC here; this server has no stream", { status: 405, headers: { Allow: "POST" } });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
  }
  const memoryOnly = new URL(request.url).searchParams.get("tools") === "memory";
  const boardOnly = new URL(request.url).searchParams.get("tools") === "board";
  const batch = Array.isArray(body);
  const answers = (await Promise.all((batch ? (body as unknown[]) : [body]).map((m) => handle(node, caller, m as Message, memoryOnly, boardOnly)))).filter(Boolean);
  if (!answers.length) return new Response(null, { status: 202 });
  return Response.json(batch ? answers : answers[0]);
}
