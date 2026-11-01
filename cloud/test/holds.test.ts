import { reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownerToken, worker } from "./login";

let owner: string;

const send = async (method: string, path: string, body?: unknown, token = owner) => {
  const res = await worker(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json<any>() };
};

const TEMPLATES = {
  coding: { needsApproval: false, memory: 4096, cores: 2, capNames: ["coding"] },
  mail: { needsApproval: true, memory: 2048, cores: 1, capNames: ["mail"], credentials: ["google"] },
};

beforeEach(async () => {
  owner = await ownerToken();
  expect((await send("PUT", "/api/fleet/environments/local", { templates: TEMPLATES })).status).toBe(200);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("holds", () => {
  it("list what brains and templates hold, recorded or not, with who holds it", async () => {
    const { body } = await send("GET", "/api/holds");
    expect(body).toEqual([
      { name: "corkboard", about: "", where: null, secret: null, recorded: false, brains: ["pepper"], templates: [] },
      { name: "google", about: "", where: null, secret: null, recorded: false, brains: ["pepper"], templates: ["local/mail"] },
    ]);
  });

  it("are made, changed against their version, and never show their secret", async () => {
    const made = await send("POST", "/api/holds", { name: "github", about: "Pushes to Forgejo", secret: "ghp_x" });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ name: "github", about: "Pushes to Forgejo", recorded: true, brains: [] });
    expect(made.body.secret).toMatch(/^\d{4}-/);
    expect(JSON.stringify((await send("GET", "/api/holds")).body)).not.toContain("ghp_x");
    expect((await send("POST", "/api/holds", { name: "github" })).status).toBe(409);
    expect((await send("POST", "/api/holds", { name: "no spaces" })).status).toBe(400);

    const changed = await send("PATCH", "/api/holds/github", { updated: made.body.updated, where: "the droplet", secret: null });
    expect(changed.body).toMatchObject({ where: "the droplet", secret: null });
    const stale = await send("PATCH", "/api/holds/github", { updated: made.body.updated, about: "lost" });
    expect(stale.status).toBe(409);
    expect(stale.body.hold.where).toBe("the droplet");
  });

  it("move on every brain when renamed, and come off them when removed", async () => {
    const made = (await send("POST", "/api/holds", { name: "corkboard", secret: "cbt" })).body;
    const renamed = await send("PATCH", "/api/holds/corkboard", { updated: made.updated, name: "board" });
    expect(renamed.body).toMatchObject({ name: "board", brains: ["pepper"] });
    expect((await send("GET", "/api/brains/pepper")).body.credentials).toEqual(["google", "board"]);
    expect((await send("GET", "/api/holds/corkboard")).status).toBe(404);

    expect((await send("DELETE", "/api/holds/board")).status).toBe(204);
    expect((await send("GET", "/api/brains/pepper")).body.credentials).toEqual(["google"]);
  });

  it("a template holds are its Nix config's to rename or remove", async () => {
    const made = (await send("POST", "/api/holds", { name: "google" })).body;
    expect((await send("PATCH", "/api/holds/google", { updated: made.updated, name: "gmail" })).body.error).toContain("local/mail");
    expect((await send("DELETE", "/api/holds/google")).status).toBe(409);
  });

  it("hand a spawn the secrets of what its brain and its template hold", async () => {
    await send("POST", "/api/holds", { name: "google", secret: "{\"refresh\":\"r\"}" });
    await send("POST", "/api/holds", { name: "corkboard", secret: "cbt" });
    const s = (await send("POST", "/api/spawns", { template: "coding", brain: "pepper", task: "x" })).body;
    expect((await send("POST", `/api/spawns/${s.id}/claim`, { environment: "local" })).body.secrets).toEqual({ google: "{\"refresh\":\"r\"}", corkboard: "cbt" });
    const m = (await send("POST", "/api/spawns", { template: "mail", task: "x" })).body;
    expect((await send("POST", `/api/spawns/${m.id}/claim`, { environment: "local" })).body.secrets).toEqual({ google: "{\"refresh\":\"r\"}" });
    const plain = (await send("POST", "/api/spawns", { template: "coding", task: "x" })).body;
    expect((await send("POST", `/api/spawns/${plain.id}/claim`, { environment: "local" })).body.secrets).toBeUndefined();
  });
});
