// The Brains tab's operations on the node (app.ts's brains): making a
// brain, changing it (a form's edit refused when it changed since it was
// read), archiving, restoring, and the purge that isn't one yet, on a node
// whose account is only on this machine.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { newRoot } from "../../lib/e2ee/keys";
import { offline } from "../../lib/e2ee/sync";
import { brains } from "./app";
import { Data } from "./data";
import { Episodes } from "./episodes";
import { listObjects } from "./objects";
import { Replicas } from "./replicas";
import { Search } from "./search";
import type { StartedNode } from "./serve";

let replicas: Replicas, data: Data, n: StartedNode;
beforeAll(async () => {
  const root = newRoot();
  replicas = await Replicas.open({ objects: listObjects(root, { boards: [], brains: ["pepper"] }), transport: offline, device: "node" });
  await replicas.start({ live: false });
  data = new Data(replicas, "UTC");
  await data.putBrain("pepper", { title: "Pepper", default: true });
  n = {
    data,
    search: new Search(data),
    episodes: new Episodes(),
    addBrain: (name: string) => replicas.add(listObjects(root, { boards: [], brains: [name] })[0]),
  } as unknown as StartedNode;
});
afterAll(() => replicas.stop());

const op = (name: string, ...args: unknown[]) => brains(n, name, args);
type Brain = { name: string; title: string; description: string; updated: string; archived?: string | null; default?: boolean; model?: string | null; abilities?: string[] };

describe("brains_create", () => {
  it("makes a brain from the starter, its fields trimmed, the rest left out", async () => {
    const b = (await op("brains_create", { name: "work", title: "  Work  ", description: " For work. ", model: " openai:small@http://box:8000/v1 ", nonsense: 1, __proto__: { x: 1 } })) as Brain & Record<string, unknown>;
    expect(b).toMatchObject({ name: "work", title: "Work", description: "For work.", model: "openai:small@http://box:8000/v1", default: false, abilities: [] });
    expect(b.nonsense).toBeUndefined();
    expect(Object.hasOwn(b, "__proto__")).toBe(false);
    expect(typeof b.updated).toBe("string");
    // Kept by the node, its own object, and listed.
    expect(replicas.objects("brain").map((o) => o.name).sort()).toEqual(["pepper", "work"]);
    const list = (await op("brains_get")) as (Brain & { memory: Record<string, unknown> })[];
    expect(list.map((x) => [x.name, x.default])).toEqual([["pepper", true], ["work", false]]);
    expect(list[1].memory).toEqual({ notes: 0, entries: 0, episodes: 0, lastEpisode: null });
  });

  it("refuses a bad name, one taken, no title, a bad model or key", async () => {
    for (const name of [undefined, "", "Work", "1st", "a b", "constructor-".repeat(4), "../x"])
      await expect(op("brains_create", { name, title: "T" })).rejects.toThrow("name must be lowercase letters");
    await expect(op("brains_create", { name: "work", title: "T" })).rejects.toThrow("there's already a brain work");
    await expect(op("brains_create", { name: "untitled" })).rejects.toThrow("a brain needs a title");
    await expect(op("brains_create", { name: "untitled", title: "  " })).rejects.toThrow("title must be a line");
    await expect(op("brains_create", { name: "untitled", title: "T", model: "gemini:pro" })).rejects.toThrow("model: no provider gemini");
    await expect(op("brains_create", { name: "untitled", title: "T", model_key: "not a hold!" })).rejects.toThrow("model_key must name a hold");
    expect(replicas.objects("brain").map((o) => o.name)).not.toContain("untitled");
  });
});

describe("brains_update", () => {
  it("changes what it's given, and a null clears a field", async () => {
    const b = (await op("brains_update", "work", { description: "Still work.", model: "" })) as Brain;
    expect([b.title, b.description, b.model]).toEqual(["Work", "Still work.", null]);
  });

  it("refuses a form's edit made to the brain as it was, giving it as it is", async () => {
    const read = data.brain("work") as Brain;
    const mine = (await op("brains_update", "work", { title: "Mine", updated: read.updated })) as Brain;
    expect(mine.title).toBe("Mine");
    // Within the same second, updated still moves on, so the second form's
    // edit, from the brain as it was, is stale.
    expect(mine.updated > read.updated).toBe(true);
    const theirs = (await op("brains_update", "work", { title: "Theirs", updated: read.updated })) as { stale: Brain; error: string };
    expect(theirs.error).toBe("work changed since; here it is now");
    expect(theirs.stale.title).toBe("Mine");
    expect(data.brain("work").title).toBe("Mine");
    // Without updated, it's not a form's, and goes in.
    expect(((await op("brains_update", "work", { title: "Anyone" })) as Brain).title).toBe("Anyone");
  });

  it("makes one brain the default, and the old one not", async () => {
    await op("brains_update", "work", { default: true });
    expect(data.defaultBrain()).toBe("work");
    expect(data.brain("pepper").default).toBe(false);
    await op("brains_update", "pepper", { default: true });
    expect(data.defaultBrain()).toBe("pepper");
  });

  it("refuses a brain that isn't there", async () => {
    for (const name of ["nobody", "constructor", "__proto__", undefined]) await expect(op("brains_update", name, { title: "T" })).rejects.toThrow(`no brain ${name}`);
  });
});

describe("brains_archive, brains_restore and brains_purge", () => {
  it("archives a brain, which can't be made again until it's restored", async () => {
    await expect(op("brains_archive", "pepper")).rejects.toThrow("the default brain can't be archived");
    const a = (await op("brains_archive", "work")) as Brain;
    expect(typeof a.archived).toBe("string");
    expect(a.default).toBe(false);
    await expect(op("brains_create", { name: "work", title: "Again" })).rejects.toThrow("there's an archived brain work; restore it first");
    // Its memory stays.
    await data.putNote("work", "kept", { kind: "reference", title: "Kept", body: "still here\n" });
    const r = (await op("brains_restore", "work")) as Brain;
    expect(r.archived).toBeNull();
    expect(r.title).toBe("Anyone");
    expect(data.note("work", "kept")!.body).toBe("still here\n");
  });

  it("an archived brain isn't the default, even if its settings say so", async () => {
    await op("brains_update", "work", { default: true });
    await expect(op("brains_archive", "work")).rejects.toThrow("the default brain can't be archived");
    await op("brains_update", "pepper", { default: true });
    await op("brains_archive", "work");
    // Made the default while archived, it still isn't: the first one not archived is.
    await op("brains_update", "work", { default: true });
    expect(data.brain("pepper").default).toBe(false);
    expect(data.defaultBrain()).toBe("pepper");
    expect(((await op("brains_get")) as Brain[]).find((b) => b.name === "work")!.default).toBe(false);
  });

  it("doesn't purge an encrypted brain, and loses nothing trying", async () => {
    await expect(op("brains_purge", "work")).rejects.toThrow("an encrypted brain isn't purged from here yet");
    await expect(op("brains_purge", "nobody")).rejects.toThrow("no brain nobody");
    expect(data.note("work", "kept")!.body).toBe("still here\n");
    expect(replicas.objects("brain").map((o) => o.name)).toContain("work");
  });
});
