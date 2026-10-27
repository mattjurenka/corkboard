// corkboard-fleet: spawn agents into this machine's slots, and see them.
//
//   corkboard-fleet spawn <template> [--repo DIR] [--account NAME] <task...>
//   corkboard-fleet list
//   corkboard-fleet show <id>          its state, and its answer when done
//   corkboard-fleet attach <id>        a shell in its slot while it runs
//   corkboard-fleet stop <id>
//   corkboard-fleet fetch <id>         its commits, as branch fleet/<id> in its repo
//   corkboard-fleet templates
//   corkboard-fleet queue              the Worker's spawns, wherever they run
//   corkboard-fleet approve <id>       a brain's spawn that holds credentials

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLOUD, token } from "../../bridge/cloud";
import { accountFor, answer, manifest, newId, read, schedule, SPAWNS, spawns, write, type Spawn } from "./fleet";

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

const [cmd, ...args] = process.argv.slice(2);

async function cloud(method: string, path: string) {
  const res = await fetch(`${CLOUD}${path}`, { method, headers: { Authorization: `Bearer ${await token().catch((e) => die(e.message))}` } });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) die(json.error ?? `HTTP ${res.status}`);
  return json;
}

const need = (id?: string): Spawn => (id && read(id)) || die(`no spawn ${id ?? "(none given)"}; see corkboard-fleet list`);

switch (cmd) {
  case "spawn": {
    const [template, ...rest] = args;
    let repo: string | undefined;
    let asked: string | undefined;
    const words: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--repo") repo = resolve(rest[++i] ?? die("--repo needs a directory"));
      else if (rest[i] === "--account") asked = rest[++i] ?? die("--account needs a name");
      else words.push(rest[i]);
    }
    const m = manifest();
    if (!template || !m.templates[template]) die(`spawnable here: ${Object.keys(m.templates).join(", ")}`);
    if (!words.length) die("what should it do? corkboard-fleet spawn <template> <task...>");
    if (repo && !existsSync(join(repo, ".git"))) die(`${repo} is not a git repo`);
    let account = "";
    try {
      account = accountFor(m, template, "user", asked);
    } catch (e: any) {
      die(e.message);
    }
    const s: Spawn = { id: newId(), template, task: words.join(" "), repo, by: "user", account, state: "queued", created: new Date().toISOString() };
    write(s);
    const waiting = schedule(m, spawns(), new Set()).waiting;
    console.log(s.id + (waiting?.id === s.id ? `  (queued: ${waiting.reason})` : ""));
    break;
  }

  case "list": {
    const rows = spawns().map((s) => [s.id, s.state, s.template, s.account, s.slot ?? "", s.created.slice(5, 16).replace("T", " "), s.task.slice(0, 50)]);
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
      console.log(`${name}  ${t.memory} MiB, ${t.cores} cores, ${t.capNames.join(" ") || "-"}${t.brain ? `, ${t.brain} brain as ${t.account}` : ""}${t.needsApproval ? "  (holds credentials)" : ""}`);
    break;
  }

  case "queue": {
    const rows = ((await cloud("GET", "/api/spawns?limit=30")) as any[]).map((s) => [s.id, s.state, s.template, s.environment, s.by, `${s.board}/${s.card}`, s.created.slice(5, 16).replace("T", " "), s.task.split("\n")[0].slice(0, 50)]);
    const widths = rows.reduce((w, r) => r.map((c: string, i: number) => Math.max(w[i] ?? 0, c.length)), [] as number[]);
    for (const r of rows) console.log(r.map((c: string, i: number) => c.padEnd(widths[i])).join("  ").trimEnd());
    break;
  }

  case "approve": {
    if (!args[0]) die("which spawn? corkboard-fleet queue lists them");
    const s = await cloud("POST", `/api/spawns/${args[0]}/approve`);
    console.log(`${s.id} approved: ${s.template}, queued for ${s.environment}`);
    break;
  }

  default:
    die("corkboard-fleet spawn|list|show|attach|stop|fetch|templates|queue|approve");
}
