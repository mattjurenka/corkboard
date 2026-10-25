// The day plan end to end: a plan proposed over MCP shows up live in the day
// plan's window (a headless Neovim, CORKBOARD_WINDOW=plan, with this script
// as its bridge), what's said there reaches the Worker, and accepting runs
// dayplan apply before telling the Worker.
//
//   bun run test:plan         needs bun run login first
//
// Today's plan and the calendar are never touched: the date is in 2099
// (CORKBOARD_PLAN_DATE) and dayplan is a stand-in that writes down what it
// was given (CORKBOARD_DAYPLAN). The plan is deleted after.
import { decodeMultiStream, encode } from "@msgpack/msgpack";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as boards from "../bridge/boards";
import { CLOUD, token } from "../bridge/cloud";

const DATE = `2099-01-${String(1 + Math.floor(Math.random() * 27)).padStart(2, "0")}`;
const dir = mkdtempSync(join(tmpdir(), "corkboard-plan-"));
const fake = join(dir, "dayplan");
writeFileSync(fake, `#!/bin/sh\ncat > ${dir}/applied.json\necho "wrote the stand-in calendar"\n`);
chmodSync(fake, 0o755);

const nvim = Bun.spawn(["nvim", "--embed", "--headless", "--clean", "--cmd", `set rtp^=${new URL("../nvim", import.meta.url).pathname}`], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env, CORKBOARD_WINDOW: "plan", CORKBOARD_PLAN_DATE: DATE, CORKBOARD_DAYPLAN: fake, CORKBOARD_PLAN_CLAUDE: "0" },
});
const send = (m: unknown) => {
  nvim.stdin.write(encode(m));
  nvim.stdin.flush();
};
const session = new boards.Session((key, event) =>
  send([2, "nvim_exec_lua", [key === boards.USER ? "require('corkboard.plan').cloud_event(...)" : "require('corkboard.cards').cloud_event(...)", key === boards.USER ? [event] : [key, event]]]),
);
let nextId = 1;
const waiting = new Map<number, (v: [unknown, unknown]) => void>();
(async () => {
  for await (const msg of decodeMultiStream(nvim.stdout) as AsyncIterable<any[]>) {
    if (msg[0] === 1) waiting.get(msg[1])?.([msg[2], msg[3]]);
    else if (msg[0] === 2 && msg[1] === "corkboard.cloud") {
      const [id, op, ...args] = msg[2];
      const answer = (a: object) => send([2, "nvim_exec_lua", ["require('corkboard.cards.cloud').answer(...)", [{ id, ...a }]]]);
      session.call(op, args).then((r) => answer({ result: r ?? null }), (e) => answer({ error: e.message }));
    }
  }
})();
function lua(code: string, ...args: unknown[]): Promise<any> {
  const id = nextId++;
  send([0, id, "nvim_exec_lua", [code, args]]);
  return new Promise((resolve, reject) => waiting.set(id, ([err, res]) => (err ? reject(new Error(JSON.stringify(err))) : resolve(res))));
}
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + JSON.stringify(detail)}`);
  if (!ok) process.exitCode = 1;
};
const api = async (method: string, path: string, body?: unknown) =>
  (await fetch(`${CLOUD}${path}`, { method, headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" }, body: body && JSON.stringify(body) }))
    .json()
    .catch(() => null);
const mcp = (name: string, args: object) =>
  api("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }).then((r: any) =>
    r.result.isError ? Promise.reject(new Error(r.result.content[0].text)) : JSON.parse(r.result.content[0].text),
  );
const until = async <T>(get: () => Promise<T>, ok: (v: T) => boolean) => {
  let v = await get();
  for (let i = 0; i < 50 && !ok(v); i++) {
    await Bun.sleep(100);
    v = await get();
  }
  return v;
};
const state = () => lua("local plan, diff = require('corkboard.plan').state(); return { plan = plan, diff = diff }");

try {
  // corkboard's startup opens the plan's tab and reads the plan.
  const empty = await until(state, (s) => s.plan && s.plan.problem === undefined);
  check("the window opens on an empty plan", empty.plan.blocks.length === 0 && !empty.plan.proposal, empty);

  await mcp("plan_propose", {
    date: DATE,
    from: 0,
    blocks: [
      { id: "linkedin", start: 900, stop: 945, title: "Jobs: LinkedIn follow-ups", kind: "work", desc: "Open LinkedIn", project: "jobs" },
      { id: "class", start: 990, stop: 1065, title: "School: class", kind: "fixed" },
      { id: "twilio", start: 1080, stop: 1140, title: "Side: Twilio application", kind: "work", desc: "Log into Twilio" },
    ],
    reasons: [{ text: "first plan of the day", source: "test" }],
    why: { twilio: "owed since yesterday" },
    projects: [{ key: "jobs", name: "job search", color: "accent" }],
  });
  const proposed = await until(state, (s) => s.plan.proposal === true);
  check("a proposal made over MCP shows up live", proposed.plan.proposal === true && proposed.diff?.lines.length === 3, proposed);

  await lua("vim.ui.input = function(_, done) done('no Twilio today') end; require('corkboard.plan').say()");
  const plan = await until(() => api("GET", `/api/plans/${DATE}`), (p: any) => p.asked?.length === 1);
  check("what's said reaches the Worker", plan.asked[0] === "no Twilio today", plan.asked);

  // A first plan is all one hunk: there's nothing before it. Undoing it
  // leaves nothing, which accept refuses, since accepting opens the gate.
  await lua("local p = require('corkboard.plan'); p.undo_hunk(1); p.accept()");
  await Bun.sleep(800);
  const refused = await api("GET", `/api/plans/${DATE}`);
  check("an empty plan isn't accepted", !refused.accepted && !!refused.proposal, refused);
  await lua("require('corkboard.plan').load()"); // the undone hunk back, from the Worker

  await lua("require('corkboard.plan').accept()");
  const accepted = await until(() => api("GET", `/api/plans/${DATE}`), (p: any) => !!p.accepted);
  check("accepting writes the day on the Worker", !accepted.proposal && accepted.day.blocks.map((b: any) => b.id).join() === "linkedin,class,twilio", accepted.day);
  const applied = JSON.parse(readFileSync(join(dir, "applied.json"), "utf8"));
  check(
    "dayplan was given the work blocks, not the fixed class",
    applied.approve === true && applied.blocks.map((b: any) => b.title).join() === "Jobs: LinkedIn follow-ups,Side: Twilio application" &&
      applied.blocks[0].start === `${DATE}T15:00` && applied.blocks[0].desc === "Open LinkedIn",
    applied,
  );
  const shown = await until(state, (s) => !s.plan.proposal && s.plan.blocks.length === 3);
  check("the window shows the accepted day", shown.plan.blocks.length === 3, shown.plan.blocks);

  // A re-plan with two separate changes, the class unchanged between them.
  await mcp("plan_propose", {
    date: DATE,
    from: 0,
    blocks: [
      { id: "linkedin", start: 905, stop: 950, title: "Jobs: LinkedIn follow-ups", kind: "work" },
      { id: "class", start: 990, stop: 1065, title: "School: class", kind: "fixed" },
      { id: "twilio", start: 1080, stop: 1140, title: "Side: finish the Twilio form", kind: "work" },
    ],
    reasons: [{ text: "moved things" }],
  });
  const replan = await until(state, (s) => s.plan.proposal === true);
  check("a re-plan's separate changes are separate hunks", replan.diff.hunks.length === 2, replan.diff);
  await lua(`local p = require('corkboard.plan'); local _, diff = p.state()
    for _, l in ipairs(diff.lines) do if l.id == "twilio" and l.hunk then p.undo_hunk(l.hunk) end end
    p.accept()`);
  const kept = await until(() => api("GET", `/api/plans/${DATE}`), (p: any) => !p.proposal);
  const byId = Object.fromEntries(kept.day.blocks.map((b: any) => [b.id, b]));
  check("an undone hunk keeps the old block; the rest is accepted", byId.linkedin?.start === 905 && byId.twilio?.title === "Side: Twilio application", kept.day.blocks);

  // A failing dayplan leaves the plan unaccepted.
  writeFileSync(fake, "#!/bin/sh\necho 'not signed in' >&2\nexit 1\n");
  await mcp("plan_propose", { date: DATE, from: 0, blocks: [{ id: "x", start: 1200, stop: 1260, title: "Life: x", kind: "work" }] });
  await until(state, (s) => s.plan.proposal === true);
  await lua("require('corkboard.plan').accept()");
  await Bun.sleep(1500);
  const after = await api("GET", `/api/plans/${DATE}`);
  check("when dayplan fails, nothing is accepted", !!after.proposal && after.day.blocks.length === 3, after);
} catch (e) {
  check("ran", false, (e as Error).message);
} finally {
  await api("DELETE", `/api/plans/${DATE}`);
  session.close();
  nvim.kill();
  process.exit();
}
