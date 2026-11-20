// The page's msgpack-RPC to Neovim, as JSON over the bridge's websocket
// (rpc.js), against a websocket server here on a port of its own that
// plays the bridge.
import { afterAll, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { Rpc } from "./rpc.js";

// What the bridge got, and the socket to answer on.
const got: unknown[] = [];
let peer: ServerWebSocket<unknown> | undefined;
const server = Bun.serve({
  port: 0,
  fetch: (req, srv) => (srv.upgrade(req, { headers: { "sec-websocket-protocol": req.headers.get("sec-websocket-protocol")?.split(",")[0] ?? "" } }) ? undefined : new Response("no", { status: 400 })),
  websocket: {
    open: (ws) => void (peer = ws),
    message: (_ws, m) => void got.push(JSON.parse(String(m))),
  },
});
afterAll(() => server.stop(true));

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(ok()).toBe(true);
};
const connect = () => new Rpc(`ws://localhost:${server.port}/`, ["corkboard"]);

test("what's sent before the socket opens goes once it has, in order", async () => {
  got.length = 0;
  const rpc = connect();
  rpc.notify("nvim_input", "a");
  const answer = rpc.request("nvim_eval", "1+1");
  rpc.notify("nvim_input", "b");
  await rpc.ready;
  await until(() => got.length === 3);
  expect(got).toEqual([
    [2, "nvim_input", ["a"]],
    [0, 1, "nvim_eval", ["1+1"]],
    [2, "nvim_input", ["b"]],
  ]);
  peer!.send(JSON.stringify([1, 1, null, 2]));
  expect(await answer).toBe(2);
  rpc.ws.close();
});

test("answers by id, in any order; an error rejects", async () => {
  got.length = 0;
  const rpc = connect();
  await rpc.ready;
  const a = rpc.request("a");
  const b = rpc.request("b", 1, [2]);
  await until(() => got.length === 2);
  expect(got).toEqual([
    [0, 1, "a", []],
    [0, 2, "b", [1, [2]]],
  ]);
  peer!.send(JSON.stringify([1, 2, null, "B"]));
  peer!.send(JSON.stringify([1, 1, [0, "E5108: boom"], null]));
  expect(await b).toBe("B");
  expect(await a.then(() => "resolved", (e) => e)).toEqual([0, "E5108: boom"]);
  // An answer to nothing asked is let go.
  peer!.send(JSON.stringify([1, 99, null, "x"]));
  rpc.ws.close();
});

test("notifications go to their handler; a request from Neovim is answered that nothing handles it", async () => {
  got.length = 0;
  const rpc = connect();
  const seen: unknown[] = [];
  rpc.on("redraw", (params: unknown) => void seen.push(params));
  await rpc.ready;
  peer!.send(JSON.stringify([2, "redraw", [["flush", []]]]));
  peer!.send(JSON.stringify([2, "constructor", []]));
  peer!.send(JSON.stringify([0, 7, "ask", []]));
  await until(() => got.length === 1 && seen.length === 1);
  expect(seen).toEqual([[["flush", []]]]);
  expect(got).toEqual([[1, 7, "no handler", null]]);
  rpc.ws.close();
});

test("a close goes to the close handler with its code and reason", async () => {
  const rpc = connect();
  let closed: CloseEvent | undefined;
  rpc.on("close", (e: CloseEvent) => void (closed = e));
  await rpc.ready;
  peer!.close(4001, "wrong token");
  await until(() => !!closed);
  expect([closed!.code, closed!.reason]).toEqual([4001, "wrong token"]);
});

test("a socket that can't open rejects ready", async () => {
  const dead = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 400 }) });
  const rpc = new Rpc(`ws://localhost:${dead.port}/`);
  expect(await rpc.ready.then(() => "opened", () => "refused")).toBe("refused");
  dead.stop(true);
});
