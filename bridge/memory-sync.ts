// A brain's vault into its memory in corkboard's Worker (cloud/src/memory.ts):
// until the vault is a mirror of the memory (.agent/plans/memory.md, step
// 5), the files are the truth and this copies them up, one way.
//
//   bun bridge/memory-sync.ts [--dry] <brain> <vault>    e.g. work ~/second-brain/vault
//
// --dry: what it would send, sent nowhere.
//
// Every Markdown file is a note, its id from its path (Decisions/x.md is
// decisions-x; the memory files are soul, user, memory and heartbeat), its
// kind from its folder. The daily logs (Memory/daily/YYYY-MM-DD.md) are the
// brain's log instead: each top-level bullet an entry on that day, at the
// time its section's heading gives. Both are sent whole every run; the
// Worker keeps what hasn't changed as it was, so a run only changes what
// changed. A file deleted here stays in the memory, and is listed.
//
// As the bridge, with its sign-in (bridge/cloud.ts).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CLOUD, token } from "./cloud";

const dry = process.argv.includes("--dry");
const [brain, vault] = process.argv.slice(2).filter((a) => a !== "--dry");
if (!brain || !vault) {
  console.error("bun bridge/memory-sync.ts [--dry] <brain> <vault>");
  process.exit(2);
}

// The vault's clock: its daily logs are in Phoenix time, which keeps no DST.
const OFFSET = "-07:00";

const KINDS: [RegExp, string][] = [
  [/^Memory\/drafts\//, "draft"],
  [/^Memory\//, "memory"],
  [/^Decisions\//, "decision"],
  [/^Projects\//, "project"],
  [/^Team\//, "person"],
  [/^Research\//, "research"],
];
const NAMED: Record<string, string> = { "Memory/SOUL.md": "soul", "Memory/USER.md": "user", "Memory/MEMORY.md": "memory", "Memory/HEARTBEAT.md": "heartbeat" };
const DAILY = /^Memory\/daily\/(\d{4}-\d{2}-\d{2})\.md$/;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

// The Worker's ids are lowercase-and-dashes, at most 80 long; a longer one
// keeps its start and a hash, so it stays the same each run.
function idOf(path: string) {
  if (NAMED[path]) return NAMED[path];
  const id = path.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "note";
  return id.length <= 80 ? id : `${id.slice(0, 71).replace(/-+$/, "")}-${hash(path).slice(0, 8)}`;
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    // Obsidian's settings and trash, lock files, and anything hidden.
    if (name.startsWith(".") || name === "~") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (name.endsWith(".md")) yield p;
  }
}

type Entry = { day: string; at: string; who: string; text: string; key: string };

// A day's log: under each heading, every top-level bullet (with what's
// indented under it) is an entry, and a paragraph is one too. The time is
// the heading's HH:MM, or the day's start without one.
function entries(day: string, text: string): Entry[] {
  const out: Entry[] = [];
  let heading = "";
  let at = `${day}T04:00:00${OFFSET}`;
  let current: string[] = [];
  let bullet = false;
  const flush = () => {
    const t = current.join("\n").trim();
    current = [];
    bullet = false;
    if (!t) return;
    const time = new Date(at).toISOString().replace(/\.\d+Z$/, "Z");
    out.push({ day, at: time, who: heading.replace(/\s*\d{1,2}:(\d{2}|xx)\b/, "").slice(0, 80) || "log", text: t, key: hash(`${day}\n${heading}\n${t}`).slice(0, 40) });
  };
  for (const line of text.split("\n")) {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      flush();
      if (/^#\s/.test(line) || /^##\s+Sessions\s*$/.test(line)) continue;
      heading = h[1].trim();
      const m = heading.match(/\b(\d{1,2}):(\d{2})\b/);
      at = m ? `${day}T${m[1].padStart(2, "0")}:${m[2]}:00${OFFSET}` : at;
    } else if (/^[-*]\s/.test(line)) {
      flush();
      bullet = true;
      current.push(line.replace(/^[-*]\s+/, ""));
    } else if (!line.trim()) {
      // A paragraph ends at a blank line; a bullet at the next bullet or heading.
      if (!bullet) flush();
    } else current.push(bullet ? line.replace(/^ {2}/, "") : line);
  }
  flush();
  return out;
}

// The vault, read: its notes and its log.
type Note = { id: string; kind: string; title: string; body: string; path: string };
const found: Note[] = [];
const log: Entry[] = [];
let skipped = 0;
for (const file of files(vault)) {
  const path = relative(vault, file);
  const body = readFileSync(file, "utf8");
  const daily = path.match(DAILY);
  if (daily) {
    log.push(...entries(daily[1], body));
    continue;
  }
  const id = idOf(path);
  const why = body.length > 200_000 ? "longer than the Worker's 200000 characters" : found.some((n) => n.id === id) ? `its id ${id} is another file's` : "";
  if (why) {
    console.warn(`skipped ${path}: ${why}`);
    skipped++;
    continue;
  }
  const kind = KINDS.find(([re]) => re.test(path))?.[1] ?? "reference";
  const title = (body.match(/^#\s+(.+)$/m)?.[1] ?? path.split("/").pop()!.replace(/\.md$/, "")).trim().slice(0, 200);
  found.push({ id, kind, title, body, path });
}

if (dry) {
  const kinds = found.reduce((m, n) => ((m[n.kind] = (m[n.kind] ?? 0) + 1), m), {} as Record<string, number>);
  console.log(`${brain}: would send ${found.length} notes ${JSON.stringify(kinds)}, ${log.length} log entries on ${new Set(log.map((e) => e.day)).size} days`);
  for (const n of found) console.log(`  ${n.kind.padEnd(9)} ${n.id}  ${n.title.slice(0, 60)}`);
  for (const e of log.slice(-3)) console.log(`  entry ${e.day} ${e.at} ${e.who}: ${e.text.slice(0, 100).replace(/\n/g, " ⏎ ")}`);
  process.exit(0);
}

const auth = { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" };
const api = (path: string, init: RequestInit = {}) => fetch(`${CLOUD}${path}${path.includes("?") ? "&" : "?"}brain=${brain}`, { ...init, headers: auth });

let changed = 0;
for (const n of found) {
  const before = await (await api(`/api/notes/${n.id}`)).json<any>().catch(() => ({}));
  const res = await api(`/api/notes/${n.id}`, { method: "PUT", body: JSON.stringify({ kind: n.kind, title: n.title, body: n.body, path: n.path }) });
  if (!res.ok) throw new Error(`${n.path}: ${res.status} ${await res.text()}`);
  if ((await res.json<any>()).version !== before.version) changed++;
}

let added = 0;
for (let i = 0; i < log.length; i += 500) {
  const res = await api("/api/memory/entries", { method: "POST", body: JSON.stringify({ entries: log.slice(i, i + 500) }) });
  if (!res.ok) throw new Error(`entries: ${res.status} ${await res.text()}`);
  added += (await res.json<any>()).added;
}

const ids = new Set(found.map((n) => n.id));
const gone = (await (await api("/api/notes?limit=200")).json<any[]>()).map((n) => n.id).filter((id) => !ids.has(id));
console.log(`${brain}: ${found.length} notes (${changed} changed${skipped ? `, ${skipped} skipped` : ""}), ${log.length} log entries (${added} new)`);
if (gone.length) console.log(`in the memory but not the vault: ${gone.join(", ")}`);
