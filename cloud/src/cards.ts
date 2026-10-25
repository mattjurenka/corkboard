// The card model, as the API speaks it. The same fields as a card file's
// front matter (mcp/cards.ts), with the description as a field of its own
// and the log as rows beside the card rather than a section of its body.

export const STATUSES = ["backlog", "ready", "doing", "review", "done"] as const;
export const AGENT_STATES = ["queued", "working", "blocked", "needs-review", "done"] as const;

export type Status = (typeof STATUSES)[number];
export type AgentState = (typeof AGENT_STATES)[number];

export type Card = {
  id: string;
  title: string;
  status: Status;
  agent: string | null;
  agent_state: AgentState | null;
  attention: string | null;
  ordinal: number | null;
  labels: string[];
  dependencies: string[];
  description: string;
  // Front matter corkboard doesn't know, kept from imported card files.
  extra: Record<string, unknown>;
  created: string;
  updated: string;
  // Bumped by every change to the fields above; a write names the version it
  // read, so two editors can't silently overwrite each other.
  version: number;
};

// seq orders a board's entries and tells a copy which ones it already has.
export type LogEntry = { seq: number; at: string; who: string; note: string };

// What a board's live socket sends after each write.
export type BoardEvent =
  | { type: "card"; card: Card }
  | { type: "log"; id: string; entry: LogEntry }
  // The whole board, with logs: after an import, which changes everything.
  | { type: "snapshot"; cards: (Card & { log?: LogEntry[] })[] };

// What a create or an update may set.
export type Fields = Partial<Omit<Card, "id" | "created" | "updated" | "version">>;

export class Invalid extends Error {}

// A card as an import brings it: its own id, times and log.
export type Imported = { id: string; fields: Fields; created: string; updated: string; log: Omit<LogEntry, "seq">[] };

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

export function imported(input: unknown): Imported {
  const { id, created, updated, log = [], ...rest } = (input ?? {}) as Record<string, unknown>;
  if (typeof created !== "string" || !ISO.test(created)) throw new Invalid(`card ${id}: created must be an ISO time, like 2026-10-24T07:03:30Z`);
  if (typeof updated !== "string" || !ISO.test(updated)) throw new Invalid(`card ${id}: updated must be an ISO time`);
  if (!Array.isArray(log)) throw new Invalid(`card ${id}: log must be a list`);
  const f = fields(rest);
  if (!f.title) throw new Invalid(`card ${id}: a card needs a title`);
  return {
    id: cardId(String(id)),
    fields: f,
    created,
    updated,
    log: log.map((e) => {
      const { at } = e as Record<string, unknown>;
      if (typeof at !== "string" || !ISO.test(at)) throw new Invalid(`card ${id}: each log entry needs an ISO at`);
      return { at, ...logEntry(e) };
    }),
  };
}

const MAX_TITLE = 300;
const MAX_ATTENTION = 200;
const MAX_TEXT = 100_000;

// TASK-12, case-insensitively; returned upper-case.
export function cardId(id: string): string {
  if (!/^[a-z]+-\d+$/i.test(id)) throw new Invalid(`bad card id ${id}; ids look like TASK-12`);
  return id.toUpperCase();
}

const strings = (name: string, v: unknown): string[] => {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new Invalid(`${name} must be a list of strings`);
  return v.map((s) => s.trim()).filter(Boolean);
};

const nullable = (name: string, v: unknown, max: number): string | null => {
  if (v === null) return null;
  if (typeof v !== "string") throw new Invalid(`${name} must be a string or null`);
  const t = v.trim();
  if (t.length > max) throw new Invalid(`${name} is longer than ${max} characters`);
  return t || null;
};

// Checks and normalizes fields from a request. Unknown keys are refused
// rather than dropped, so a typo is an error and not a write that did nothing.
export function fields(input: unknown): Fields {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Invalid("expected an object");
  const out: Fields = {};
  for (const [k, v] of Object.entries(input)) {
    switch (k) {
      case "title": {
        if (typeof v !== "string" || !v.trim()) throw new Invalid("title must be a non-empty string");
        if (v.trim().length > MAX_TITLE) throw new Invalid(`title is longer than ${MAX_TITLE} characters`);
        out.title = v.trim();
        break;
      }
      case "status":
        if (!STATUSES.includes(v as Status)) throw new Invalid(`status must be one of ${STATUSES.join(", ")}`);
        out.status = v as Status;
        break;
      case "agent":
        out.agent = nullable(k, v, MAX_TITLE);
        break;
      case "agent_state":
        if (v !== null && !AGENT_STATES.includes(v as AgentState))
          throw new Invalid(`agent_state must be one of ${AGENT_STATES.join(", ")}, or null`);
        out.agent_state = v as AgentState | null;
        break;
      case "attention":
        out.attention = nullable(k, v, MAX_ATTENTION);
        break;
      case "ordinal":
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw new Invalid("ordinal must be a number or null");
        out.ordinal = v as number | null;
        break;
      case "labels":
        out.labels = strings(k, v);
        break;
      case "dependencies":
        out.dependencies = strings(k, v).map(cardId);
        break;
      case "description":
        if (typeof v !== "string") throw new Invalid("description must be a string");
        if (v.length > MAX_TEXT) throw new Invalid(`description is longer than ${MAX_TEXT} characters`);
        out.description = v.trim();
        break;
      case "extra":
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Invalid("extra must be an object");
        out.extra = v as Record<string, unknown>;
        break;
      default:
        throw new Invalid(`unknown field ${k}`);
    }
  }
  return out;
}

export function logEntry(input: unknown): { who: string; note: string } {
  const { who, note } = (input ?? {}) as Record<string, unknown>;
  if (typeof who !== "string" || !who.trim()) throw new Invalid("who must be a non-empty string");
  if (typeof note !== "string" || !note.trim()) throw new Invalid("note must be a non-empty string");
  if (note.length > MAX_TEXT) throw new Invalid(`note is longer than ${MAX_TEXT} characters`);
  return { who: who.trim(), note: note.trim() };
}

// The dependencies a card still waits on: those not done, and ids with no
// card, which can never be done. As mcp/cards.ts's waitingOn.
export function waitingOn(card: Card, cards: Card[]): string[] {
  if (card.status === "done") return [];
  const status = new Map(cards.map((c) => [c.id, c.status]));
  return card.dependencies
    .filter((d) => status.get(d) !== "done")
    .map((d) => (status.has(d) ? d : `${d} (no such card)`));
}
