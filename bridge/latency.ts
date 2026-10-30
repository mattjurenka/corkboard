// `bun run latency [minutes]`: the key-to-pixels timings the pages sent
// (web/src/latency.ts, appended by /latency in server.ts), summarised. By
// key: how many, and the median, 95th percentile and worst of each stage.
// Then the slowest keys with their wall-clock times, to set against what
// the machine was doing then. Keys that arrived while the screen was already
// changing (busy) are left out: their first change may not be theirs.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "corkboard", "latency.jsonl");
const minutes = Number(process.argv[2] ?? 60);
const since = Date.now() - minutes * 60_000;

type Sample = { t: number; key: string; busy: boolean; input: number; change: number | null; paint: number | null; via: string | null; event?: number; cwd?: string | null };

let text = "";
try {
  text = readFileSync(LOG, "utf8");
} catch {
  console.log(`nothing yet in ${LOG}`);
  process.exit(0);
}
const all = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Sample).filter((s) => s.t >= since);
const clean = all.filter((s) => !s.busy);

const q = (v: number[], p: number) => (v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(p * v.length))]) : NaN);
const stats = (v: number[]) => {
  v.sort((a, b) => a - b);
  return `${q(v, 0.5)}/${q(v, 0.95)}/${Math.round(v.at(-1) ?? NaN)}`;
};

console.log(`${all.length} keys in the last ${minutes} min, ${all.length - clean.length} busy (left out), ${clean.filter((s) => s.paint === null).length} changed nothing`);
console.log("ms, as median/p95/max\n");
const rows = [...Map.groupBy(clean, (s) => s.key)]
  .sort((a, b) => b[1].length - a[1].length)
  .map(([key, xs]) => {
    const moved = xs.filter((s) => s.paint !== null);
    return {
      key,
      n: xs.length,
      input: stats(xs.map((s) => s.input)),
      change: stats(moved.map((s) => s.change!)),
      paint: stats(moved.map((s) => s.paint!)),
    };
  });
console.table(rows.slice(0, 25));

const slow = clean.filter((s) => s.paint !== null).sort((a, b) => b.paint! - a.paint!).slice(0, 10);
console.log("\nslowest:");
for (const s of slow) {
  const at = new Date(s.t).toLocaleTimeString([], { hour12: false });
  const browser = s.event ? `, browser ${Math.round(s.event)}` : "";
  console.log(`  ${at}  ${s.key.padEnd(10)} paint ${Math.round(s.paint!)}  (input ${Math.round(s.input)}, change ${Math.round(s.change!)} via ${s.via}${browser})  ${s.cwd ?? ""}`);
}
