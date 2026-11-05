// Memory off the Worker, into this account's brains on this machine (step 7
// of .agent/plans/local-memory.md): frozen there, copied here table by table,
// checked, and only then purged there. What fails on the way unfreezes it,
// and a second run copies only what the first didn't.

import { type Data, importedEntryId } from "./data";
import type { Episodes } from "./episodes";
import type { Replicas } from "./replicas";
import type { Note } from "../../lib/model/plans";

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
