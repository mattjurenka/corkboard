import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { type Page, ask, closed, command, enter, list, opened, peers, report } from "./away";

// A page as away.ts sees one: what it was told, and the Lua it was given.
type Heard = { notes: [string, unknown[]][]; execs: [string, unknown[]][] };
const pages: (Page & Heard)[] = [];
function page(host?: string): Page & Heard {
  const p: Page & Heard = {
    host,
    notes: [],
    execs: [],
    notify(method, ...params) {
      p.notes.push([method, params]);
    },
    exec(lua, ...args) {
      p.execs.push([lua, args]);
    },
  };
  pages.push(p);
  opened(p);
  return p;
}
const chimes = (p: Heard) => p.notes.filter(([m]) => m === "corkboard.chime").length;
const lastAway = (p: Heard) => p.notes.filter(([m]) => m === "corkboard.away").at(-1)?.[1][0] as { wake: string | null; sessions: { project: string; name: string; state: string }[] } | null;
const s = (buf: number, state: string, project = "proj", more: object = {}) => ({ buf, project, name: `claude ${buf}`, state, ...more });

let t = Date.parse("2026-11-20T10:00:00Z");
const tick = (ms = 1000) => setSystemTime(new Date((t += ms)));

afterEach(() => {
  if (pages[0]) command(pages[0], "leave", []);
  for (const p of pages.splice(0)) closed(p);
  peers([]);
  setSystemTime();
});

describe("away mode", () => {
  it("wakes you once when a session asks, not for one that asked before you left", () => {
    tick();
    const a = page();
    report(a, [s(1, "permission"), s(2, "working")]);
    tick();
    enter(a);
    expect(lastAway(a)!.sessions.map((x) => x.state)).toEqual(["needs", "working"]);
    expect(chimes(a)).toBe(0);
    tick();
    report(a, [s(1, "permission"), s(2, "asking", "other")]);
    expect(chimes(a)).toBe(1);
    expect(lastAway(a)!.wake).toBe("other needs you");
    // Once: more asking doesn't chime again.
    tick();
    report(a, [s(1, "working"), s(2, "asking", "other"), s(3, "asking")]);
    expect(chimes(a)).toBe(1);
  });

  it("wakes you when every session has stopped, counting only those that stopped while away", () => {
    tick();
    const a = page();
    report(a, [s(1, "idle"), s(2, "working")]);
    tick();
    enter(a);
    // Every one stopped, but none since you left.
    report(a, [s(1, "idle"), s(2, "background")]);
    expect(chimes(a)).toBe(0);
    tick();
    report(a, [s(1, "idle"), s(2, "ready")]);
    expect(lastAway(a)!.wake).toBe("all stopped");
    expect(lastAway(a)!.sessions.map((x) => x.state)).toEqual(["idle", "ready"]);
    expect(chimes(a)).toBe(1);
  });

  it("wakes you when one has sat finished for twenty minutes while others work", () => {
    tick();
    const a = page();
    report(a, [s(1, "working"), s(2, "working")]);
    enter(a);
    tick();
    report(a, [s(1, "ready"), s(2, "working")]);
    tick(20 * 60 * 1000 - 1000);
    report(a, [s(1, "ready"), s(2, "working")]);
    expect(chimes(a)).toBe(0);
    tick(1000);
    report(a, [s(1, "ready"), s(2, "working")]);
    expect(lastAway(a)!.wake).toBe("proj waited 20m");
    expect(chimes(a)).toBe(1);
  });

  it("stays away on space, counting only what comes after, and chimes on the page that said so", () => {
    tick();
    const a = page();
    const b = page();
    report(a, [s(1, "working")]);
    enter(a);
    tick();
    report(a, [s(1, "asking")]);
    expect(chimes(a)).toBe(1);
    tick();
    command(b, "stay", []);
    expect(lastAway(b)!.wake).toBeNull();
    // Still asking, but from before: no wake.
    report(a, [s(1, "asking")]);
    expect(chimes(b)).toBe(0);
    tick();
    report(a, [s(1, "working"), s(2, "permission")]);
    expect(chimes(b)).toBe(1);
    expect(chimes(a)).toBe(1);
  });

  it("leaves out sessions attached in a VM, names another machine's, and counts another bridge's", () => {
    tick();
    const a = page();
    const remote = page("laptop");
    report(a, [s(1, "working"), s(2, "attached", "proj", { vm: "vm-1" })]);
    report(remote, [s(1, "working", "pepper")]);
    peers([{ bridge: "dev", key: "k1", project: "dev:corkboard", name: "claude", state: "working", attach: true, terminal: false }]);
    enter(a);
    expect(lastAway(a)!.sessions.map((x) => x.project)).toEqual(["proj", "laptop:pepper", "dev:corkboard"]);
    // The fleet view still lists the attached one, and whose page each is.
    expect(list(a).map((x) => [x.buf, x.state, x.vm, x.host, x.mine])).toEqual([
      [1, "working", undefined, undefined, true],
      [2, "attached", "vm-1", undefined, true],
      [1, "working", undefined, "laptop", false],
    ]);
    tick();
    peers([{ bridge: "dev", key: "k1", project: "dev:corkboard", name: "claude", state: "asking", attach: true, terminal: false }]);
    expect(lastAway(a)!.wake).toBe("dev:corkboard needs you");
  });

  it("keeps how long a session has been in its state while its state's kind stays", () => {
    tick();
    const a = page();
    report(a, [s(1, "working")]);
    const at = list()[0].since;
    tick();
    report(a, [s(1, "background")]);
    expect(list()[0].since).toBe(at);
    tick();
    report(a, [s(1, "idle")]);
    expect(list()[0].since).toBe(t);
    // Every page's fleet view hears of each change.
    expect(a.execs.at(-1)![0]).toBe("require('corkboard.fleet').sessions(...)");
  });

  it("chimes on another page when the one that went away has closed", () => {
    tick();
    const a = page();
    const b = page();
    report(b, [s(1, "working")]);
    enter(a);
    closed(a);
    tick();
    report(b, [s(1, "asking")]);
    expect(chimes(b)).toBe(1);
  });
});

describe("going to a session", () => {
  it("leaves and brings up a page's session in its own page", () => {
    const a = page();
    const b = page();
    report(b, [s(4, "asking")]);
    enter(a);
    const id = list().find((x) => x.buf === 4)!.page!;
    command(a, "go", [id, 4]);
    expect(b.execs.at(-1)).toEqual(["require('corkboard.terminal').focus(...)", [4]]);
    expect(b.notes.slice(-2)).toEqual([
      ["corkboard.away_return", [false]],
      ["corkboard.front", []],
    ]);
    expect(lastAway(a)).toBeNull();
  });

  it("opens another bridge's mirrored where it can be, else its conversation, and nothing for one it can't", () => {
    const a = page();
    peers([
      { bridge: "dev", key: "t", project: "dev:x", name: "one", state: "working", attach: true, terminal: true },
      { bridge: "dev", key: "c", project: "dev:x", name: "two", state: "working", attach: true, terminal: false },
      { bridge: "dev", key: "n", project: "dev:x", name: "three", state: "working", attach: false, terminal: false },
    ]);
    command(a, "show", ["dev", "t"]);
    expect(a.execs.at(-1)).toEqual(["require('corkboard.mirror').open(...)", ["dev", "t", "one"]]);
    command(a, "show", ["dev", "c"]);
    expect(a.execs.at(-1)).toEqual(["require('corkboard.conversation').open(...)", ["dev", "c", "two"]]);
    const before = a.execs.length;
    command(a, "show", ["dev", "n"]);
    command(a, "show", ["dev", "constructor"]);
    expect(a.execs.length).toBe(before);
    enter(a);
    command(a, "go", ["dev", "c"]);
    expect(a.notes.at(-1)).toEqual(["corkboard.away_return", [true]]);
  });
});

describe("asking a page's Neovim", () => {
  it("gets the answer to its question, and says when the page is closed", async () => {
    const a = page();
    const id = (report(a, [s(1, "working")]), list()[0].page!);
    const answer = ask(id, "screen", 1);
    const [lua, [q, buf]] = a.execs.at(-1)! as [string, [number, number]];
    expect(lua).toBe("require('corkboard.away').screen(...)");
    expect(buf).toBe(1);
    command(a, "answer", [q, { text: "on screen" }]);
    expect(await answer).toEqual({ text: "on screen" });
    expect(await ask(9999, "say", "hi")).toEqual({ error: "that session's page is closed", missing: true });
  });
});
