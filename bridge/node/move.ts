// Memory off the Worker, into this account's brains on this machine (step 7
// of .agent/plans/local-memory.md): frozen there, copied here table by table,
// checked, and only then purged there. What fails on the way unfreezes it,
// and a second run copies only what the first didn't.

import { type PlainCard, changesFor } from "./board";
import { type Data, importedEntryId } from "./data";
import type { Episodes } from "./episodes";
import type { Media } from "./media";
import type { Replicas } from "./replicas";
import { importedMessageId } from "./day";
import type { ChatMessage, Note, Plan } from "../../lib/model/plans";

// The Worker's API, signed in: a path and what fetch takes.
export type Worker = (path: string, init?: RequestInit) => Promise<Response>;
export type MoveTarget = { data: Data; episodes: Episodes; replicas: Replicas; account: string; addBrain(name: string): Promise<void> };
export type Moved = Record<string, { notes: number; entries: number; episodes: number }>;

type Row = Record<string, string | number | null>;
type Move = { account: string; state: "moving" | "moved"; at: string; brains: string[] };

// The Worker's brain record, as the node keeps one (its id is the Worker's tokens').
const BRAIN_FIELDS = ["title", "description", "account", "credentials", "abilities", "persona", "skin", "default", "archived", "created"];

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function call<T>(worker: Worker, path: string, init?: RequestInit): Promise<T> {
  const res = await worker(path, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

async function rows(worker: Worker, brain: string, table: string, episode?: string): Promise<Row[]> {
  const all: Row[] = [];
  for (let after = 0; ; ) {
    const q = new URLSearchParams({ table, after: String(after), ...(episode !== undefined && { episode }) });
    const page = await call<{ rows: Row[]; next: number | null }>(worker, `/api/memory/move/${brain}?${q}`);
    all.push(...page.rows);
    if (page.next === null) return all;
    after = page.next;
  }
}

const str = (v: unknown) => String(v ?? "");

async function copyBrain(n: MoveTarget, worker: Worker, name: string, record: Row | undefined) {
  if (!n.data.brains().some((b) => b.name === name)) await n.addBrain(name);
  const set: Record<string, unknown> = record ? Object.fromEntries(BRAIN_FIELDS.filter((f) => record[f] !== undefined).map((f) => [f, record[f]])) : { title: name === "pepper" ? "Pepper" : name };
  await n.data.putBrain(name, set);

  const notes = await rows(worker, name, "notes");
  for (const r of notes)
    await n.data.importNote(name, { id: str(r.id), kind: r.kind as Note["kind"], title: str(r.title), body: str(r.body), created: str(r.created), updated: str(r.updated), version: Number(r.version) || 1 });

  const entries = (await rows(worker, name, "entries")).map((r) => ({ from: `worker:${r.id}`, at: str(r.at), day: str(r.day), who: str(r.who), text: str(r.text) }));
  await n.data.importEntries(name, entries);

  const episodes = await rows(worker, name, "episodes");
  for (const r of episodes) {
    const id = str(r.id);
    if (n.episodes.transcript(name, id) !== undefined) continue;
    const parts = (await rows(worker, name, "episode_parts", id)).sort((a, b) => Number(a.seq) - Number(b.seq));
    if (parts.length !== Number(r.parts) || parts.some((p, i) => Number(p.seq) !== i)) throw new Error(`${name}: episode ${id} has ${parts.length} of its ${r.parts} parts`);
    n.episodes.restore(name, {
      id,
      session: str(r.session),
      agent: str(r.agent),
      trigger: str(r.trigger),
      at: str(r.at),
      bytes: Number(r.bytes),
      consolidated: !!r.consolidated,
      transcript: parts.map((p) => str(p.text)).join(""),
    });
  }

  for (const r of await rows(worker, name, "consolidated_sessions")) n.episodes.restoreThrough(name, str(r.session), str(r.through));
  const rolled = (await rows(worker, name, "meta")).find((r) => r.key === "rolled");
  if (rolled && str(rolled.value) > (n.data.rolled(name) ?? "")) await n.data.setRolled(name, str(rolled.value));

  // Everything the Worker has, here.
  const missing = [
    ...notes.filter((r) => (n.data.note(name, str(r.id))?.version ?? 0) < (Number(r.version) || 1)).map((r) => `note ${r.id}`),
    ...(() => {
      const have = new Set(n.data.entries(name).map((e) => e.id));
      return entries.filter((e) => !have.has(importedEntryId(e.from, e.at))).map((e) => `entry ${e.from}`);
    })(),
    ...episodes.filter((r) => n.episodes.transcript(name, str(r.id)) === undefined).map((r) => `episode ${r.id}`),
  ];
  if (missing.length) throw new Error(`${name}: not copied: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
  return { notes: notes.length, entries: entries.length, episodes: episodes.length };
}

// dryRun: everything but the purge, and the Worker's memory unfrozen after.
export async function moveMemory(n: MoveTarget, worker: Worker, o: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<Moved> {
  const log = o.log ?? console.log;
  const move = await call<Move>(worker, "/api/memory/move", post({ account: n.account }));
  const moved: Moved = {};
  try {
    const records = await call<Row[]>(worker, "/api/brains?archived=1");
    for (const name of move.brains) {
      moved[name] = await copyBrain(n, worker, name, records.find((r) => r.name === name));
      log(`brain ${name.padEnd(30)} ${moved[name].notes} notes, ${moved[name].entries} entries, ${moved[name].episodes} episodes`);
    }
    await n.replicas.settled();
    const unsent = n.replicas.status().filter((s) => s.kind === "brain" && (s.pending > 0 || s.error));
    if (unsent.length) throw new Error(`not on the relay yet: ${unsent.map((s) => `${s.name} (${s.error ?? `${s.pending} changes`})`).join(", ")}`);
  } catch (e) {
    await call(worker, "/api/memory/move", { method: "DELETE" }).catch(() => {});
    throw e;
  }
  if (o.dryRun) await call(worker, "/api/memory/move", { method: "DELETE" });
  else await call(worker, "/api/memory/move/done", post({ account: n.account }));
  return moved;
}

// The boards off the Worker too (step 7 of .agent/plans/local-boards.md), the
// same way: frozen there, each copied into its replica here with its cards'
// ids, times, logs and files, checked, and only then deleted there. Leases
// stay behind: an agent still working claims its card again here.
export type BoardsTarget = { data: Data; replicas: Replicas; media: Media; account: string; addBoard(key: string): Promise<void> };
export type BoardsMoved = Record<string, { cards: number; files: number }>;

type WorkerBoard = { key: string; name: string; root: string | null; commit?: string | null; remotes?: string[]; roots: Record<string, string> };
type BoardMove = { account: string; state: "moving" | "moved"; at: string; handle: string; node: string; boards: WorkerBoard[] };
type WorkerCard = PlainCard & { log: { at: string; who: string; note: string }[]; extra?: Record<string, unknown> };
type WorkerMedia = { id: string; name: string; type: string; size: number; at: string; who: string };

async function cardsOf(worker: Worker, key: string): Promise<WorkerCard[]> {
  const all: WorkerCard[] = [];
  for (let after = 0; ; ) {
    const page = await call<{ cards: WorkerCard[]; next: number | null }>(worker, `/api/boards/move/${encodeURIComponent(key)}?after=${after}`);
    all.push(...page.cards);
    if (page.next === null) return all;
    after = page.next;
  }
}

// A file's bytes as the Worker serves them, asked for only once they're read.
async function* fileOf(worker: Worker, path: string): AsyncIterable<Uint8Array> {
  const res = await worker(path);
  if (!res.ok || !res.body) throw new Error(`GET ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
  yield* res.body as unknown as AsyncIterable<Uint8Array>;
}

const entryOf = (e: { at: string; who: string; note: string }) => JSON.stringify([e.at, e.who, e.note]);

async function copyBoard(n: BoardsTarget, worker: Worker, b: WorkerBoard) {
  if (!n.replicas.get("board", b.key)) await n.addBoard(b.key);
  await n.data.putBoard(b.key, { name: b.name, root: b.root, commit: b.commit ?? null, remotes: b.remotes ?? [], roots: b.roots });

  // The files go in media records of their own (media.ts), not in extra.
  const cards = await cardsOf(worker, b.key);
  const files = (c: WorkerCard) => (Array.isArray(c.extra?.media) ? (c.extra.media as WorkerMedia[]) : []);
  const had = new Map(n.replicas.get("board", b.key)!.cards().map((c) => [c.id, c]));
  const changes = cards.flatMap((c) => {
    const { media: _, ...extra } = c.extra ?? {};
    return changesFor({ ...c, extra }, had.get(c.id));
  });
  if (changes.length) await n.replicas.change("board", b.key, ...changes);
  for (const c of cards)
    for (const m of files(c))
      await n.media.restore(b.key, { ...m, card: c.id }, fileOf(worker, `/api/boards/move/${encodeURIComponent(b.key)}/media/${encodeURIComponent(c.id)}/${m.id}`));

  // Everything the Worker has, here.
  const here = new Map(n.data.cards(b.key, true).map((c) => [c.id, c]));
  const kept = new Set(n.data.media(b.key).map((s) => s.id));
  const missing = cards.flatMap((c) => {
    const h = here.get(c.id);
    if (!h) return [`card ${c.id}`];
    const logged = new Set(h.log.map(entryOf));
    return [
      ...(c.log.every((e) => logged.has(entryOf(e))) ? [] : [`${c.id}'s log`]),
      ...files(c).filter((m) => !kept.has(m.id)).map((m) => `${c.id}'s ${m.name}`),
    ];
  });
  if (missing.length) throw new Error(`${b.key}: not copied: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
  return { cards: cards.length, files: cards.reduce((t, c) => t + files(c).length, 0) };
}

// dryRun: everything but the delete, and the Worker's boards unfrozen after.
export async function moveBoards(n: BoardsTarget, worker: Worker, o: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<BoardsMoved> {
  const log = o.log ?? console.log;
  const move = await call<BoardMove>(worker, "/api/boards/move", post({ account: n.account }));
  const moved: BoardsMoved = {};
  try {
    for (const b of move.boards) {
      moved[b.key] = await copyBoard(n, worker, b);
      log(`board ${b.key.padEnd(40)} ${moved[b.key].cards} cards, ${moved[b.key].files} files`);
    }
    await n.replicas.settled();
    const unsent = n.replicas.status().filter((s) => s.kind === "board" && s.name in moved && (s.pending > 0 || s.error));
    if (unsent.length) throw new Error(`not on the relay yet: ${unsent.map((s) => `${s.name} (${s.error ?? `${s.pending} changes`})`).join(", ")}`);
  } catch (e) {
    await call(worker, "/api/boards/move", { method: "DELETE" }).catch(() => {});
    throw e;
  }
  if (o.dryRun) await call(worker, "/api/boards/move", { method: "DELETE" });
  else await call(worker, "/api/boards/move/done", post({ account: n.account }));
  return moved;
}

// The day plans and the chat off the Worker too (step 5 of
// .agent/plans/local-plans.md), into the day object, the same way. The
// calendar's connection stays on the Worker, which lends the node access
// tokens from it (calendar.ts's lentCalendar): one consent, every device.
export type PlansTarget = { data: Data; replicas: Replicas; account: string };
export type PlansMoved = { plans: number; messages: number; calendar: { connected: boolean; id: string | null; timezone: string } | null };

type PlanMove = { account: string; state: "moving" | "moved"; at: string; calendar: PlansMoved["calendar"] };

async function paged<T>(worker: Worker, path: string, key: "plans" | "messages"): Promise<T[]> {
  const all: T[] = [];
  for (let after = ""; ; ) {
    const page = await call<Record<string, unknown>>(worker, `${path}?after=${encodeURIComponent(after)}`);
    all.push(...(page[key] as T[]));
    if (page.next === null) return all;
    after = String(page.next);
  }
}

// dryRun: everything but the delete, and the Worker's plans back after.
export async function movePlans(n: PlansTarget, worker: Worker, o: { dryRun?: boolean; log?: (line: string) => void } = {}): Promise<PlansMoved> {
  const log = o.log ?? console.log;
  const move = await call<PlanMove>(worker, "/api/plans/move", post({ account: n.account }));
  let moved: PlansMoved;
  try {
    const plans = await paged<Plan>(worker, "/api/plans/move/plans", "plans");
    for (const p of plans) await n.data.importPlan(p);
    const messages = await paged<ChatMessage>(worker, "/api/plans/move/chat", "messages");
    await n.data.importChat(messages);

    // Everything the Worker has, here.
    const have = new Set(n.data.chat(undefined, Infinity).map((m) => m.id));
    const missing = [
      ...plans.filter((p) => JSON.stringify(n.data.plan(p.date).day) !== JSON.stringify(p.day) || (!!p.proposal !== !!n.data.plan(p.date).proposal)).map((p) => `plan ${p.date}`),
      ...messages.filter((m) => !have.has(importedMessageId(m.id, m.at))).map((m) => `message ${m.id}`),
    ];
    if (missing.length) throw new Error(`not copied: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
    moved = { plans: plans.length, messages: messages.length, calendar: move.calendar };
    log(`day plans ${plans.length}, chat messages ${messages.length}`);

    await n.replicas.settled();
    const unsent = n.replicas.status().filter((s) => s.kind === "day" && (s.pending > 0 || s.error));
    if (unsent.length) throw new Error(`not on the relay yet: ${unsent.map((s) => s.error ?? `${s.pending} changes`).join(", ")}`);
  } catch (e) {
    await call(worker, "/api/plans/move", { method: "DELETE" }).catch(() => {});
    throw e;
  }
  if (o.dryRun) await call(worker, "/api/plans/move", { method: "DELETE" });
  else await call(worker, "/api/plans/move/done", post({ account: n.account }));
  return moved;
}
