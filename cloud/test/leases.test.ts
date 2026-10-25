import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env as bindings } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LEASE_MS } from "../src/board";
import type { Env } from "../src/index";
import { ownerToken, worker } from "./login";

const BOARD = "home-matthew-corkboard";
let owner: string;

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// The board's Durable Object, as the Worker names it for the test account.
const env = bindings as unknown as Env;
const stub = () => env.BOARD.get(env.BOARD.idFromName(`sub-me@example.com/${BOARD}`));

beforeEach(async () => {
  owner = await ownerToken();
  await call(owner, "PUT", `/api/boards/${BOARD}`, { name: "corkboard" });
  await call(owner, "POST", `/api/boards/${BOARD}/cards`, { title: "Mine", status: "ready" });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

let rpcId = 0;
async function tool(token: string, name: string, args: object = {}) {
  const res = await call(token, "POST", "/mcp", { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } });
  const body = await res.json<any>();
  const text = body.result.content[0].text;
  return body.result.isError ? { error: text } : JSON.parse(text);
}

async function cardToken(card = "TASK-1", agent = "claude") {
  const res = await call(owner, "POST", "/api/tokens", { board: BOARD, card, agent });
  return (await res.json<{ token: string }>()).token;
}

const card = async (id = "TASK-1") => (await call(owner, "GET", `/api/boards/${BOARD}/cards/${id}`)).json<any>();
const alarm = async () => runInDurableObject(stub(), (_o, state) => state.storage.getAlarm());

// Time passes: the card's last change and every lease are older than a lease.
async function silence(ms = LEASE_MS + 1000) {
  await runInDurableObject(stub(), (_o, state) => {
    const past = new Date(Date.now() - ms).toISOString().replace(/\.\d+Z$/, "Z");
    state.storage.sql.exec("UPDATE cards SET updated = ?", past);
    state.storage.sql.exec("UPDATE leases SET until = ?", Date.now() - ms);
  });
}

describe("a claim's lease", () => {
  it("is armed by a claim and lapses into blocked when the agent goes quiet", async () => {
    const token = await cardToken();
    expect(await alarm()).toBeNull();
    await tool(token, "claim_card", { id: "TASK-1" });
    const armed = await alarm();
    expect(armed).toBeGreaterThan(Date.now() + LEASE_MS - 60_000);

    await silence();
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    const c = await card();
    expect(c).toMatchObject({ status: "doing", agent: "claude", agent_state: "blocked", attention: expect.stringMatching(/claude stopped responding/) });
    expect(c.log.at(-1)).toMatchObject({ who: "corkboard", note: expect.stringMatching(/nothing from claude for 15 minutes/) });
    // Nothing is working, so nothing is left to wake for.
    expect(await alarm()).toBeNull();
  });

  it("is kept by the holder's board calls and by the heartbeat", async () => {
    const token = await cardToken();
    await tool(token, "claim_card", { id: "TASK-1" });
    await silence();
    await tool(token, "list_cards");
    await runDurableObjectAlarm(stub());
    expect((await card()).agent_state).toBe("working");

    await silence();
    const res = await call(owner, "POST", `/api/boards/${BOARD}/cards/TASK-1/lease`, { agent: "claude" });
    expect((await res.json<any>()).until).toBeGreaterThan(Date.now());
    await runDurableObjectAlarm(stub());
    expect((await card()).agent_state).toBe("working");
  });

  it("isn't kept by someone who doesn't hold the card", async () => {
    await tool(await cardToken(), "claim_card", { id: "TASK-1" });
    await silence();
    const res = await call(owner, "POST", `/api/boards/${BOARD}/cards/TASK-1/lease`, { agent: "someone" });
    expect(await res.json()).toBeNull();
    await runDurableObjectAlarm(stub());
    expect((await card()).agent_state).toBe("blocked");
  });

  it("comes back when a lapsed agent turns out to be alive", async () => {
    const token = await cardToken();
    await tool(token, "claim_card", { id: "TASK-1" });
    await silence();
    await runDurableObjectAlarm(stub());
    await tool(token, "log", { id: "TASK-1", note: "still here" });
    const c = await card();
    expect(c).toMatchObject({ agent_state: "working", attention: null });
    expect(c.log.map((e: any) => e.note)).toContain("claude is responding again, so it's back to working");
  });

  it("stays lapsed once the card has been changed since", async () => {
    const token = await cardToken();
    await tool(token, "claim_card", { id: "TASK-1" });
    await silence();
    await runDurableObjectAlarm(stub());
    // The user queued it again.
    const { version } = await card();
    await call(owner, "PATCH", `/api/boards/${BOARD}/cards/TASK-1`, { version, agent_state: "queued" });
    await call(owner, "POST", `/api/boards/${BOARD}/cards/TASK-1/lease`, { agent: "claude" });
    expect((await card()).agent_state).toBe("queued");
  });

  it("doesn't lapse while blocked or held by the budget guard", async () => {
    const token = await cardToken();
    await tool(token, "claim_card", { id: "TASK-1" });
    await tool(token, "block", { id: "TASK-1", question: "Which way?" });
    expect(await alarm()).toBeNull();

    let { version } = await card();
    await call(owner, "PATCH", `/api/boards/${BOARD}/cards/TASK-1`, { version, agent_state: "working", extra: { budget_hold: "$5 a card" } });
    expect(await alarm()).toBeNull();
    await silence();
    await runDurableObjectAlarm(stub());
    expect((await card()).agent_state).toBe("working");
  });
});
