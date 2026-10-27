// corkboard-fleet: spawn agents into this machine's slots, and see them.
//
//   corkboard-fleet spawn <template> [--repo DIR] <task...>
//   corkboard-fleet list
//   corkboard-fleet show <id>          its state, and its answer when done
//   corkboard-fleet attach <id>        a shell in its slot while it runs
//   corkboard-fleet stop <id>
//   corkboard-fleet fetch <id>         its commits, as branch fleet/<id> in its repo
//   corkboard-fleet templates

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { manifest, newId, read, schedule, SPAWNS, spawns, write, type Spawn } from "./fleet";

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const [cmd, ...args] = process.argv.slice(2);

const need = (id?: string): Spawn => (id && read(id)) || die(`no spawn ${id ?? "(none given)"}; see corkboard-fleet list`);

const answer = (s: Spawn): string | undefined => {
  const f = join(SPAWNS, s.id, "result.json");
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, "utf8")).result;
  } catch {
    return readFileSync(f, "utf8");
  }
};

switch (cmd) {
  case "spawn": {
    const [template, ...rest] = args;
    let repo: string | undefined;
    const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--repo") repo = resolve(rest[++i] ?? die("--repo needs a directory"));
      else words.push(rest[i]);
    }
    const m = manifest();
    if (!template || !m.templates[template]) die(`spawnable here: ${Object.keys(m.templates).join(", ")}`);
    if (!words.length) die("what should it do? corkboard-fleet spawn <template> <task...>");
    if (repo && !existsSync(join(repo, ".git"))) die(`${repo} is not a git repo`);
    const s: Spawn = { id: newId(), template, task: words.join(" "), repo, by: "user", state: "queued", created: new Date().toISOString() };
    write(s);
    const waiting = schedule(m, spawns(), new Set()).waiting;
    console.log(s.id + (waiting?.id === s.id ? `  (queued: ${waiting.reason})` : ""));
    break;
  }

  case "list": {
    const rows = spawns().map((s) => [s.id, s.state, s.template, s.slot ?? "", s.created.slice(5, 16).replace("T", " "), s.task.slice(0, 50)]);
    const widths = rows.reduce((w, r) => r.map((c, i) => Math.max(w[i] ?? 0, c.length)), [] as number[]);
    for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
    break;
  }

  case "show": {
    const s = need(args[0]);
    console.log(JSON.stringify(s, null, 2));
    const a = answer(s);
    if (a) console.log("\n" + a);
    if (existsSync(join(SPAWNS, s.id, "work.bundle"))) console.log(`\ncommits: corkboard-fleet fetch ${s.id}`);
    break;
  }

  case "attach": {
    const s = need(args[0]);
    if (s.state !== "running" || !s.slot) die(`${s.id} is ${s.state}, not running`);
    const p = Bun.spawn([`${s.slot}-ssh`], { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(await p.exited);
  }

  case "stop": {
    const s = need(args[0]);
    if (s.state !== "queued" && s.state !== "running") die(`${s.id} is already ${s.state}`);
    write({ ...s, stopRequested: true });
    console.log(`stopping ${s.id}`);
    break;
  }

  case "fetch": {
    const s = need(args[0]);
    const bundle = join(SPAWNS, s.id, "work.bundle");
    const repo = s.repo ?? die(`${s.id} had no repo`);
    if (!existsSync(bundle)) die(`${s.id} brought back no commits`);
    const p = Bun.spawn(["git", "-C", repo, "fetch", bundle, `fleet-result:fleet/${s.id}`], { stdio: ["inherit", "inherit", "inherit"] });
    if ((await p.exited) !== 0) process.exit(1);
    console.log(`fleet/${s.id} in ${s.repo}`);
    break;
  }

  case "templates": {
    for (const [name, t] of Object.entries(manifest().templates))
      console.log(`${name}  ${t.memory} MiB, ${t.cores} cores, ${t.capNames.join(" ") || "-"}${t.needsApproval ? "  (holds credentials)" : ""}`);
    break;
  }

  default:
    die("corkboard-fleet spawn|list|show|attach|stop|fetch|templates");
}
