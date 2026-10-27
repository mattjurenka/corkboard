// Day plans, notes and the chat, as the API and the MCP tools take them.
// Stored per user (user.ts).
//
// A plan is a date's day (its blocks, the ranked work, what's not today,
// what the planner looked at) and, when the assistant has proposed one, a
// proposal: blocks from a time on, with reasons and a why per changed block.
// A first plan of the day is a proposal against an empty day. Accepting
// makes the proposal's blocks the day; only the owner can (api.ts), so no
// agent can accept a plan for itself. Times are minutes since midnight.

import { Invalid } from "./cards";

export const KINDS = ["work", "fixed", "off"] as const;

export type Block = {
  id: string;
  start: number;
  stop: number;
  title: string;
  kind: (typeof KINDS)[number];
  // The first physical step: what the block's notification says.
  desc?: string;
  project?: string;
  tag?: string;
  card?: string;
  board?: string;
  pinned?: boolean;
};

type Line = Record<string, unknown>;

export type Day = { blocks: Block[]; ranked: Line[]; later: Line[]; inputs: Line[] };

export type Proposal = {
  from: number;
  blocks: Block[];
  reasons: { text: string; source?: string; tone?: string }[];
  why: Record<string, string>;
  // The ranked work, what's not today and the inputs as the proposer saw them;
  // they become the day's when it's accepted.
  ranked?: Line[];
  later?: Line[];
  inputs?: Line[];
  made: string;
  by: string;
  // What the user had said to change, which this proposal answers.
  answering: string[];
};

export type Plan = {
  date: string;
  version: number;
  projects: { key: string; name: string; color?: string }[];
  day: Day;
  proposal: Proposal | null;
  // What the user has said to change since the last proposal.
  asked: string[];
  accepted: string | null;
};

export const emptyPlan = (date: string): Plan => ({
  date,
  version: 0,
  projects: [],
  day: { blocks: [], ranked: [], later: [], inputs: [] },
  proposal: null,
  asked: [],
  accepted: null,
});

export function date(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\d$/.test(v)) throw new Invalid("date must be YYYY-MM-DD");
  return v;
}

// Today where the user is, for tools that default to it.
// The day turns over at 4am, not midnight, as dayplan's does: until then it
// is still the day planned yesterday.
export const DAY_STARTS_HOUR = 4;
export const today = (timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() - DAY_STARTS_HOUR * 3600_000));

const text = (name: string, v: unknown, max = 500) => {
  if (typeof v !== "string" || !v.trim()) throw new Invalid(`${name} must be a non-empty string`);
  if (v.length > max) throw new Invalid(`${name} is longer than ${max} characters`);
  return v.trim();
};
const optional = (name: string, v: unknown, max = 500) => (v === undefined || v === null || v === "" ? undefined : text(name, v, max));
const minutes = (name: string, v: unknown) => {
  if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 24 * 60) throw new Invalid(`${name} must be minutes since midnight, 0 to 1440`);
  return v as number;
};

export function blocks(v: unknown): Block[] {
  if (!Array.isArray(v)) throw new Invalid("blocks must be a list");
  const seen = new Set<string>();
  const out = v.map((raw, i) => {
    const b = (raw ?? {}) as Record<string, unknown>;
    const id = text(`blocks[${i}].id`, b.id, 80);
    if (seen.has(id)) throw new Invalid(`two blocks have the id ${id}`);
    seen.add(id);
    const start = minutes(`${id}.start`, b.start);
    const stop = minutes(`${id}.stop`, b.stop);
    if (stop <= start) throw new Invalid(`${id} ends before it starts`);
    if (!KINDS.includes(b.kind as Block["kind"])) throw new Invalid(`${id}.kind must be one of ${KINDS.join(", ")}`);
    const block: Block = { id, start, stop, title: text(`${id}.title`, b.title, 200), kind: b.kind as Block["kind"] };
    for (const k of ["desc", "project", "tag", "card", "board"] as const) {
      const value = optional(`${id}.${k}`, b[k], k === "desc" ? 500 : 120);
      if (value !== undefined) block[k] = value;
    }
    if (b.pinned === true) block.pinned = true;
    return block;
  });
  return out.sort((a, b) => a.start - b.start);
}

const lines = (name: string, v: unknown): Line[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "object" && x !== null && !Array.isArray(x)))
    throw new Invalid(`${name} must be a list of objects`);
  if (JSON.stringify(v).length > 50_000) throw new Invalid(`${name} is too long`);
  return v as Line[];
};

// What plan_propose takes.
export function proposal(input: Record<string, unknown>, by: string, asked: string[]): Omit<Proposal, never> {
  const reasons = lines("reasons", input.reasons).map((r, i) => ({
    text: text(`reasons[${i}].text`, r.text),
    ...(optional(`reasons[${i}].source`, r.source, 120) ? { source: String(r.source).trim() } : {}),
    ...(optional(`reasons[${i}].tone`, r.tone, 20) ? { tone: String(r.tone).trim() } : {}),
  }));
  const why = input.why ?? {};
  if (typeof why !== "object" || Array.isArray(why) || !Object.values(why).every((w) => typeof w === "string"))
    throw new Invalid("why must map block ids to reasons");
  return {
    from: input.from === undefined ? 0 : minutes("from", input.from),
    blocks: blocks(input.blocks),
    reasons,
    why: why as Record<string, string>,
    ...(input.ranked !== undefined ? { ranked: lines("ranked", input.ranked) } : {}),
    ...(input.later !== undefined ? { later: lines("later", input.later) } : {}),
    ...(input.inputs !== undefined ? { inputs: lines("inputs", input.inputs) } : {}),
    made: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    by,
    answering: asked,
  };
}

export function projects(v: unknown): Plan["projects"] {
  return lines("projects", v).map((p, i) => ({
    key: text(`projects[${i}].key`, p.key, 40),
    name: text(`projects[${i}].name`, p.name, 80),
    ...(optional(`projects[${i}].color`, p.color, 20) ? { color: String(p.color).trim() } : {}),
  }));
}

// Notes --------------------------------------------------------------------------------

export const NOTE_KINDS = ["goal", "day", "decision", "project", "person", "review", "memory", "draft"] as const;
export type Note = { id: string; kind: (typeof NOTE_KINDS)[number]; title: string; body: string; created: string; updated: string; version?: number };

// Only the owner writes these: the assistant's identity and rules.
export const OWNER_ONLY_NOTES = new Set(["soul"]);

// Kinds only Pepper's token (the pepper grant) sees over MCP: to any other
// client they don't exist. The user sees them in corkboard, through /api.
export const PEPPER_ONLY_KINDS: readonly string[] = ["goal"];

export function noteId(v: unknown): string {
  if (typeof v !== "string" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(v)) throw new Invalid("a note id is lowercase letters, digits and -, like goals-2026");
  return v;
}

// An id from a title: "Telegram bot: launch" -> telegram-bot-launch.
export const slug = (title: string) =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";

export function note(input: Record<string, unknown>): Pick<Note, "kind" | "title" | "body"> {
  if (!NOTE_KINDS.includes(input.kind as Note["kind"])) throw new Invalid(`kind must be one of ${NOTE_KINDS.join(", ")}`);
  if (typeof input.body !== "string") throw new Invalid("body must be a string");
  if (input.body.length > 200_000) throw new Invalid("body is longer than 200000 characters");
  return { kind: input.kind as Note["kind"], title: text("title", input.title, 200), body: input.body };
}

// Chat ---------------------------------------------------------------------------------

// A message between the user ("matt", from the phone) and Pepper.
export type ChatMessage = { id: number; at: string; who: string; text: string };

export const chatText = (v: unknown) => text("text", v, 4000);
