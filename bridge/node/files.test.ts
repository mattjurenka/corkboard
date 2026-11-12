import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRoot } from "../../lib/e2ee/keys";
import { offline } from "../../lib/e2ee/sync";
import type { DeviceCert, Signed } from "../../lib/e2ee/wire";
import { listObjects } from "./objects";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { Search } from "./search";
import { OAuthStore } from "./oauth";
import { FileOffers, Files, type ToFiles } from "./files";
import { node } from "./server";

const ORIGIN = "https://node.test";
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

// Two nodes: the leader, keeping the files, and this one, passing its
// requests on to the leader's /files as if on a channel.
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-files-"));
  dirs.push(dir);
  const replicas = await Replicas.open({ objects: listObjects(newRoot(), { boards: ["proj"], brains: [] }), transport: offline, device: "node" });
  await replicas.start({ live: false });
  const data = new Data(replicas, "UTC");
  const search = new Search(data);
  const store = new Files(join(dir, "leader"));
  const device = { body: { device: "laptop", name: "laptop" } } as unknown as Signed<DeviceCert>;
  const leader = node({ data, search, oauth: new OAuthStore(join(dir, "leader.json")), files: store, origin: "http://leader.invalid" });
  const toFiles: ToFiles = (path, init = {}) => leader(new Request(`http://leader.invalid${path}`, { ...init, ...(init.body != null && { duplex: "half" }) } as RequestInit), undefined, device);
  const oauth = new OAuthStore(join(dir, "oauth.json"));
  const app = node({ data, search, oauth, files: new Files(join(dir, "here")), toFiles, fileOffers: new FileOffers(toFiles), origin: ORIGIN });
  const call = (path: string, init: RequestInit = {}, from?: Signed<DeviceCert>) => app(new Request(`${ORIGIN}${path}`, init), undefined, from);
  return { dir, store, device, oauth, app, call, stop: () => replicas.stop() };
}

const rpc = (name: string, args: unknown, token: string) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("the files on no card", () => {
  let n: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => void (n = await setup()));
  afterAll(() => n.stop());

  it("are the phone's to send, list, read and delete, on a channel, kept on the leader", async () => {
    const put = await n.call("/api/node/files?name=photo.png", { method: "PUT", body: PNG }, n.device);
    expect(put.status).toBe(201);
    const f = (await put.json()) as { id: string; name: string; type: string; size: number; who: string };
    expect(f).toMatchObject({ name: "photo.png", type: "image/png", size: PNG.length, who: "you" });
    expect(readdirSync(join(n.dir, "leader")).sort()).toEqual([f.id, `${f.id}.json`].sort());
    expect(readdirSync(join(n.dir, "here"))).toEqual([]);
    expect(((await (await n.call("/api/node/files", {}, n.device)).json()) as { id: string }[]).map((x) => x.id)).toEqual([f.id]);
    const got = await n.call(`/api/node/files/${f.id}`, {}, n.device);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await n.call(`/api/node/files/${f.id}`, { method: "DELETE" }, n.device)).status).toBe(200);
    expect(n.store.list()).toEqual([]);
  });

  it("aren't the plaintext tunnel's, nor an assistant's over HTTP", async () => {
    const owner = n.oauth.mint("phone", 1);
    expect((await n.call("/api/node/files", { headers: { Authorization: `Bearer ${owner}` } })).status).toBe(404);
    expect((await n.call("/files", {})).status).toBe(404);
  });

  it("are an agent's to list, see, keep and download over MCP", async () => {
    const token = n.oauth.mint("session", 1, "assistant");
    const tool = async (name: string, args: unknown) => ((await (await n.call("/mcp", rpc(name, args, token))).json()) as { result: { content: any[]; isError?: boolean } }).result;
    const kept = await tool("keep_file", { name: "plot.png", data: PNG.toString("base64") });
    expect(kept.isError).toBeFalsy();
    const id = JSON.parse(kept.content[0].text).id;
    expect(JSON.parse((await tool("list_files", {})).content[0].text)[0]).toMatchObject({ id, name: "plot.png", who: "assistant" });
    const seen = await tool("read_file", { id });
    expect(seen.content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });

    const link = JSON.parse((await tool("read_file", { id, download: true })).content[0].text);
    const down = await n.call(new URL(link.download).pathname);
    expect(Buffer.from(await down.arrayBuffer()).equals(PNG)).toBe(true);

    const offer = JSON.parse((await tool("keep_file", { name: "notes.txt" })).content[0].text);
    const path = new URL(offer.upload).pathname;
    expect((await n.call(path, { method: "PUT", body: "hello" })).status).toBe(201);
    expect((await n.call(path, { method: "PUT", body: "again" })).status).toBe(404);
    const text = n.store.list().find((x) => x.name === "notes.txt")!;
    expect((await tool("read_file", { id: text.id })).content[1]).toEqual({ type: "text", text: "hello" });
  });

  it("aren't a card agent's", async () => {
    const token = n.oauth.mintBound({ scope: "card", board: "proj", card: "TASK-1", agent: "a" }).token;
    const r = ((await (await n.call("/mcp", rpc("list_files", {}, token))).json()) as { result: { content: any[]; isError?: boolean } }).result;
    expect(r.isError).toBe(true);
  });
});
