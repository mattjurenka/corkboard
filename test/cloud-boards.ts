// Cloud boards end to end: a headless Neovim using cards.lua's cloud backend,
// this script standing in for the bridge (with the bridge's own boards.ts),
// against the deployed Worker. Uses a throwaway board and deletes it after.
//
//   bun run test:cloud        needs bun run login first; DEBUG=1 traces RPC
//
// corkboard's own startup runs too, so its board refresh asks for cards
// while the test's calls do: the nested case cards/cloud.lua is built for.
import { decodeMultiStream, encode } from "@msgpack/msgpack";
import { CLOUD, token } from "../bridge/cloud";
import * as boards from "../bridge/boards";

const KEY = `e2e-${Date.now()}`;
const nvim = Bun.spawn(["nvim", "--embed", "--headless", "--clean", "--cmd", `set rtp^=${new URL("../nvim", import.meta.url).pathname}`], {
  stdin: "pipe", stdout: "pipe", stderr: "inherit",
  env: { ...process.env, CORKBOARD_CLOUD_BOARDS: "1", CORKBOARD_BOARD: `/tmp/${KEY}` },
});
const send = (m: unknown) => { if (process.env.DEBUG) console.log("->", JSON.stringify(m).slice(0, 200)); nvim.stdin.write(encode(m)); nvim.stdin.flush(); };
const api = async (method: string, path: string, body?: unknown) =>
  fetch(`${CLOUD}/api/boards/${KEY}${path}`, {
    method, headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    body: body && JSON.stringify(body),
  }).then((r) => r.json().catch(() => null));

const session = new boards.Session((key, event) => send([2, "nvim_exec_lua", ["require('corkboard.cards').cloud_event(...)", [key, event]]]));
let nextId = 1;
const waiting = new Map<number, (v: [unknown, unknown]) => void>();
let bumped = false;


(async () => {
  for await (const msg of decodeMultiStream(nvim.stdout) as AsyncIterable<any[]>) {
    if (process.env.DEBUG) console.log("<-", JSON.stringify(msg).slice(0, 300));
    if (msg[0] === 1) waiting.get(msg[1])?.([msg[2], msg[3]]);
    else if (msg[0] === 2 && msg[1] === "corkboard.cloud") {
      const [id, op, ...args] = msg[2];
      const answer = (a: object) => send([2, "nvim_exec_lua", ["require('corkboard.cards.cloud').answer(...)", [{ id, ...a }]]]);
      session.call(op, args).then((r) => answer({ result: r ?? null }), (e) => answer({ error: e.message }));
    } else if (msg[0] === 0 && msg[2] === "test.bump") {
      // Another client changes the card while Neovim's change is in flight.
      const [id] = msg[3];
      const card = await api("GET", `/cards/${id}`);
      await api("PATCH", `/cards/${id}`, { version: card.version, labels: ["bumped"] });
      bumped = true;
      send([1, msg[1], null, null]);
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

try {
  check("cloud backend is on", await lua("return require('corkboard.cards').cloud()"));
  const id = await lua(`local c = require('corkboard.cards')
    local id = c.create("First card", "ready", "the description")
    c.set(id, { agent = "claude", agent_state = "working", worktree = "/tmp/wt", branch = "card/x" })
    c.log(id, "claude", "started\\nsecond line")
    c.change(id, function(card)
      c.set_description(card, "a new description")
      c.append_log(card, "me", "appended in change")
    end)
    return id`);
  check("create returns an id", id === "TASK-1", id);

  const card = await lua(`local c = require('corkboard.cards'); local card = c.get(...)
    return { status = card.status, agent = card.agent, state = card.agent_state, worktree = card.worktree, branch = card.branch,
      description = c.section(card, "DESCRIPTION"), notes = c.section(card, "NOTES"), n = #c.list() }`, id);
  check("fields round-trip", card.status === "ready" && card.agent === "claude" && card.state === "working", card);
  check("extra fields round-trip", card.worktree === "/tmp/wt" && card.branch === "card/x", card);
  check("description changed", card.description === "a new description", card);
  check("both log entries, multi-line kept", /claude: started\n  second line/.test(card.notes) && /me: appended in change/.test(card.notes), card.notes);

  const server = await api("GET", `/cards/${id}`);
  check("the Worker has it all", server.description === "a new description" && server.log.length === 2 && server.extra.worktree === "/tmp/wt", server);

  // Cleared with "" as the file backend does.
  await lua(`require('corkboard.cards').set(..., { agent_state = "", attention = "" })`, id);
  const cleared = await api("GET", `/cards/${id}`);
  check('"" clears a field', cleared.agent_state === null && cleared.attention === null, cleared);

  // A write from elsewhere arrives live.
  await api("PATCH", `/cards/${id}`, { version: cleared.version, status: "review", title: "Renamed elsewhere" });
  let live: any;
  for (let i = 0; i < 50; i++) {
    live = await lua(`local card = require('corkboard.cards').get(...); return { status = card.status, title = card.title }`, id);
    if (live.status === "review") break;
    await Bun.sleep(100);
  }
  check("another client's write shows up live", live.status === "review" && live.title === "Renamed elsewhere", live);

  // A conflict mid-change is retried on the current card.
  const after = await lua(`local c = require('corkboard.cards'); local id = ...
    local first = true
    local card = c.change(id, function(card)
      if first then first = false; vim.rpcrequest(vim.api.nvim_list_chans()[1].id, "test.bump", id) end
      card.status = "done"
    end)
    return { status = card.status, labels = card.labels }`, id);
  check("conflict retried, both changes kept", bumped && after.status === "done" && after.labels?.[0] === "bumped", after);

  const unknown = await lua(`return select(2, pcall(require('corkboard.cards').get, "TASK-99"))`);
  check("unknown card errors", unknown === "no card TASK-99", unknown);

  // An agent's session, as agents.lua sets one up: a card token from the
  // bridge, used against the Worker's MCP server.
  const other = await lua(`return require('corkboard.cards').create("For an agent", "ready", "")`);
  const grant = await lua(`return require('corkboard.cards').agent_token(..., "claude")`, other);
  check("an agent token, for the MCP server", grant.token?.startsWith("cbc_") && grant.url === `${CLOUD}/mcp`, grant);
  const mcp = (body: object) =>
    fetch(grant.url, { method: "POST", headers: { Authorization: `Bearer ${grant.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }) });
  const claimed = await (await mcp({ method: "tools/call", params: { name: "claim_card", arguments: { id: other } } })).json();
  let seen: any;
  for (let i = 0; i < 50; i++) {
    seen = await lua(`local c = require('corkboard.cards').get(...); return { status = c.status, agent = c.agent }`, other);
    if (seen.status === "doing") break;
    await Bun.sleep(100);
  }
  check("the agent's claim shows up in Neovim", !claimed.result.isError && seen.status === "doing" && seen.agent === "claude", { claimed, seen });
  const elsewhere = await (await mcp({ method: "tools/call", params: { name: "log", arguments: { id, note: "x" } } })).json();
  check("the agent can't change another card", elsewhere.result.isError === true, elsewhere);
  await lua(`require('corkboard.cards').revoke_agent_token(...)`, grant.token);
  check("a revoked agent token is refused", (await mcp({ method: "ping" })).status === 401);
} catch (e) {
  check("ran", false, (e as Error).message);
} finally {
  await api("DELETE", "");
  session.close();
  nvim.kill();
  const gone = await fetch(`${CLOUD}/api/boards`, { headers: { Authorization: `Bearer ${await token()}` } }).then((r) => r.json());
  check("throwaway board deleted", !gone.some((b: any) => b.key === KEY), gone);
  process.exit();
}
