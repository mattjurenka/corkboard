import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { ownerToken, worker } from "./login";

// Moving an account to another Worker: everything it exports, imported into
// an empty one, exports the same again (api.ts's exportAccount).

afterEach(async () => {
  await reset();
});

const call = (token: string, method: string, path: string, body?: unknown) =>
  worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("export and import", () => {
  it("copies boards, cards and their logs, memory, plans and chat", async () => {
    let owner = await ownerToken();
    await call(owner, "PUT", "/api/boards/corkboard", { root: "/home/matthew/corkboard", environment: "laptop", remotes: ["git@github.com:m/corkboard.git"] });
    const card = await (await call(owner, "POST", "/api/boards/corkboard/cards", { title: "move the Worker" })).json<{ id: string }>();
    await call(owner, "POST", `/api/boards/corkboard/cards/${card.id}/log`, { who: "claude", note: "started" });
    await call(owner, "POST", "/api/boards/corkboard/cards", { title: "second" });
    await call(owner, "PUT", "/api/notes/who-am-i", { kind: "reference", title: "Who", body: "Matt" });
    await call(owner, "POST", "/api/chat", { text: "hello Pepper" });

    const exported = await (await call(owner, "GET", "/api/export")).json<any>();
    expect(Object.keys(exported.boards)).toEqual(["corkboard"]);
    expect(exported.boards.corkboard.cards).toHaveLength(2);
    expect(exported.memory.pepper.notes.map((n: any) => n.id)).toContain("who-am-i");

    // A new Worker: nothing in it, and the same Google account signing in.
    await reset();
    owner = await ownerToken();
    const imported = await call(owner, "POST", "/api/import", exported);
    expect(imported.status).toBe(201);
    expect(await (await call(owner, "GET", "/api/export")).json()).toEqual(exported);

    const boards = await (await call(owner, "GET", "/api/boards")).json<any[]>();
    expect(boards[0]).toMatchObject({ key: "corkboard", remotes: ["git@github.com:m/corkboard.git"], environments: ["laptop"] });
    const got = await (await call(owner, "GET", `/api/boards/corkboard/cards/${card.id}`)).json<any>();
    expect(got.log.map((l: any) => l.note)).toContain("started");
    // Search still finds the note: its index is filled as it goes in.
    const found = await (await call(owner, "GET", "/api/notes?q=Matt")).json<any[]>();
    expect(found.map((n) => n.id)).toEqual(["who-am-i"]);
    // New cards carry on from the old numbers.
    const next = await (await call(owner, "POST", "/api/boards/corkboard/cards", { title: "third" })).json<{ id: string }>();
    expect(next.id).not.toBe(card.id);

    // Only once.
    expect((await call(owner, "POST", "/api/import", exported)).status).toBe(409);
  });

  it("refuses what isn't an export", async () => {
    const owner = await ownerToken();
    expect((await call(owner, "POST", "/api/import", { boards: {} })).status).toBe(400);
  });
});
