// The account's day object (.agent/plans/local-plans.md): its day plans and
// the chat, as records of one replica.
//
// A date's plan is `plan:<date>`, a field per part, so a proposal and an
// edit to the day from two devices don't overwrite each other: `day`,
// `proposal` (the latest, with its id), `projects`, `accepted` ({ at,
// proposal }: when, and which proposal), `discarded` (a proposal's id) and
// `calendar`. A proposal is still open while neither names it, so an accept
// on the phone and a new proposal at once leave the new one open. What the
// user has said to change is the record's log, an entry a time; `answered`
// lists those a proposal has answered (by time and text), and the rest are
// still asked.
//
// A message is `chat:<id>`: at, who, text, by_user, delivered, and deleted
// once taken back. Its id is its time and random, so two devices never make
// the same one, and messages are in id order.
//
// A date's meditation is `meditation:<date>`: `banked`, the seconds done
// before the run in progress, and `since`, when that run started (null:
// none). A start or a pause on any device writes both at once, so the
// phone and the laptop time the same 30 minutes.
//
// A date's feeds are `feeds:<date>`: a field per device (`laptop`, `phone`),
// the seconds it has counted, each written only by that device, so one that
// was offline adds what it counted. It's only ever seconds, never what was
// watched.

import { type Block, type ChatMessage, type Day, type Plan, type Proposal, emptyPlan } from "../../lib/model/plans";
import type { BoardState, MergedCard } from "../../lib/e2ee/merge";
import { SEP } from "./objects";

export const planRecord = (date: string) => `plan${SEP}${date}`;
export const PLAN_PREFIX = planRecord("");
export const chatRecord = (id: string) => `chat${SEP}${id}`;
export const CHAT_PREFIX = chatRecord("");
export const meditationRecord = (date: string) => `meditation${SEP}${date}`;

// What the morning gate asks of a meditation, in seconds.
export const MEDITATION_GOAL = 30 * 60;

export type Meditation = { date: string; goal: number; banked: number; since: string | null; elapsed: number; running: boolean };

export function meditationOf(date: string, m: MergedCard | undefined, at = Date.now()): Meditation {
  const banked = Math.min(MEDITATION_GOAL, typeof m?.banked === "number" && m.banked > 0 ? Math.floor(m.banked) : 0);
  const started = typeof m?.since === "string" ? Date.parse(m.since) : NaN;
  const run = Number.isFinite(started) ? Math.max(0, Math.floor((at - started) / 1000)) : 0;
  const elapsed = Math.min(MEDITATION_GOAL, banked + run);
  // A run that's reached the goal has stopped, whether or not its device said so.
  const running = Number.isFinite(started) && elapsed < MEDITATION_GOAL;
  return { date, goal: MEDITATION_GOAL, banked, since: running ? (m!.since as string) : null, elapsed, running };
}

export const feedsRecord = (date: string) => `feeds${SEP}${date}`;

export type FeedDevice = "laptop" | "phone";
export type Feeds = { date: string; laptop: number; phone: number; used: number };

export function feedsOf(date: string, f: MergedCard | undefined): Feeds {
  const seconds = (v: unknown) => (typeof v === "number" && v > 0 ? Math.floor(v) : 0);
  const laptop = seconds(f?.laptop);
  const phone = seconds(f?.phone);
  return { date, laptop, phone, used: laptop + phone };
}

// The node's messages are named by a string.
export type Message = Omit<ChatMessage, "id"> & { id: string };

// A Worker message's id here, after the move: its time, as the node's are,
// then the Worker's number, so they keep their order and a second move
// finds them.
export const importedMessageId = (id: number, at: string) => `${Date.parse(at).toString(36)}-w${String(id).padStart(9, "0")}`;

export type Accepted ={ at: string; proposal: string | null };

// A said thing's key in `answered`.
export const askKey = (e: { at: string; note: string }) => `${e.at} ${e.note}`;

// The plan's version: the latest clock among its writes, as a card's is.
export function versionOf(state: BoardState, id: string): number {
  const c = state.cards[id];
  if (!c) return 0;
  return Math.max(0, ...Object.values(c.fields).map((f) => f.stamp.clock), ...Object.values(c.log).map((l) => l.stamp.clock));
}

const isAccepted = (v: unknown): v is Accepted => !!v && typeof v === "object" && typeof (v as Accepted).at === "string";

// The proposal still open: the latest, unless it's been accepted or discarded.
export function openProposal(m: MergedCard | undefined): Proposal | null {
  const p = m?.proposal as Proposal | null | undefined;
  if (!p || typeof p !== "object") return null;
  const acc = isAccepted(m!.accepted) ? m!.accepted.proposal : undefined;
  if (p.id && (acc === p.id || m!.discarded === p.id)) return null;
  return p;
}

export function planOf(date: string, m: MergedCard | undefined, version: number): Plan {
  const p = emptyPlan(date);
  if (!m) return p;
  const answered = new Set(Array.isArray(m.answered) ? (m.answered as string[]) : []);
  const day = (m.day ?? {}) as Partial<Day>;
  return {
    ...p,
    version,
    projects: Array.isArray(m.projects) ? (m.projects as Plan["projects"]) : [],
    day: { blocks: (day.blocks ?? []) as Block[], ranked: day.ranked ?? [], later: day.later ?? [], inputs: day.inputs ?? [] },
    proposal: openProposal(m),
    asked: m.log.filter((e) => !answered.has(askKey(e))).map((e) => e.note),
    accepted: isAccepted(m.accepted) ? m.accepted.at : null,
    ...(m.calendar && typeof m.calendar === "object" ? { calendar: m.calendar as Plan["calendar"] } : {}),
  };
}

export function messageOf(m: MergedCard): Message | undefined {
  if (m.deleted || typeof m.text !== "string") return;
  return { id: m.id.slice(CHAT_PREFIX.length), at: String(m.at ?? ""), who: String(m.who ?? ""), text: m.text, by_user: m.by_user === true, delivered: typeof m.delivered === "string" ? m.delivered : null };
}

// A stale write, or one the record's state refuses (the Worker's 409),
// with the plan as it is when it's a plan's.
export class Conflict extends Error {
  constructor(
    message: string,
    readonly plan?: Plan,
  ) {
    super(message);
  }
}
