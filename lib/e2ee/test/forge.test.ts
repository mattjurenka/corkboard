import { describe, expect, it } from "bun:test";
import { certify, newDevice, revoke } from "../device";
import { type GrantTerms, MAX_CHAIN, checkChain, forgeGrantHash, grantForge, narrows, scopeOf } from "../forge";
import { accountKeys, newRoot } from "../keys";

const EXPIRES = Date.now() + 3600_000;
const none = { devices: [], grant: () => false };

function account() {
  const keys = accountKeys(newRoot());
  const laptop = newDevice();
  const cert = certify(keys, laptop, "laptop");
  return { keys, id: keys.id, laptop, cert };
}

const terms = (t: Partial<GrantTerms> = {}): GrantTerms => ({ name: "vm", repos: ["matt/corkboard"], perms: { contents: "write", issues: "read" }, refs: ["agent/*"], expires: EXPIRES, ...t });

describe("forge grants", () => {
  it("a device alone is the account", () => {
    const a = account();
    const c = checkChain(a.id, a.id, { cert: a.cert }, none);
    expect(typeof c).toBe("object");
    expect(c).toMatchObject({ holder: a.laptop.id, scope: null });
  });

  it("encodes lists sorted and refs in full", () => {
    const a = account();
    const vm = newDevice();
    const g = grantForge(a.laptop, a.id, vm.id, terms({ repos: ["Matt/Verse", "matt/corkboard"], refs: ["agent/*", "refs/tags/v1"] }));
    expect(g.body.repos).toBe("matt/corkboard matt/verse");
    expect(g.body.refs).toBe("refs/heads/agent/* refs/tags/v1");
    expect(g.body.perms).toBe("contents:write issues:read");
    expect(scopeOf(g.body)).toMatchObject({ perms: { metadata: "read", contents: "write", issues: "read" } });
  });

  it("a chain of narrower grants holds, and its holder is the last", () => {
    const a = account();
    const vm = newDevice();
    const sub = newDevice();
    const g1 = grantForge(a.laptop, a.id, vm.id, terms());
    const g2 = grantForge(vm, a.id, sub.id, terms({ perms: { contents: "read" }, refs: ["agent/card-12/*"] }), g1);
    const c = checkChain(a.id, a.id, { cert: a.cert, grants: [g1, g2] }, none);
    if (typeof c === "string") throw new Error(c);
    expect(c.holder).toBe(sub.id);
    expect(c.scope?.perms.contents).toBe("read");
    expect(c.grants).toEqual([forgeGrantHash(g1.body), forgeGrantHash(g2.body)]);
  });

  it("refuses a sub-grant wider than its parent on any axis", () => {
    const a = account();
    const vm = newDevice();
    const sub = newDevice();
    const g1 = grantForge(a.laptop, a.id, vm.id, terms({ del: false }));
    const wider: Partial<GrantTerms>[] = [
      { repos: ["matt/verse"] },
      { repos: ["matt/*"] },
      { perms: { contents: "write", issues: "write" } },
      { perms: { pull_requests: "read" } },
      { refs: null },
      { refs: ["main"] },
      { refs: ["agent*"] },
      { del: true },
      { expires: g1.body.expires + 1 },
    ];
    for (const w of wider) {
      const g2 = grantForge(vm, a.id, sub.id, terms(w), g1);
      expect(typeof checkChain(a.id, a.id, { cert: a.cert, grants: [g1, g2] }, none)).toBe("string");
    }
  });

  it("an owner's-all grant covers that owner's repos and no one else's", () => {
    const s = scopeOf(grantForge(newDevice(), "x".repeat(43), "y".repeat(43), terms({ repos: ["matt/*"] })).body);
    const c = (repos: string[]) => scopeOf(grantForge(newDevice(), "x".repeat(43), "y".repeat(43), terms({ repos })).body);
    if (typeof s === "string") throw new Error(s);
    expect(narrows(c(["matt/corkboard", "matt/*"]) as any, s)).toBeNull();
    expect(narrows(c(["mattx/corkboard"]) as any, s)).not.toBeNull();
  });

  it("refuses a grant not issued by the key before it, unsigned, expired, or too deep", () => {
    const a = account();
    const vm = newDevice();
    const other = newDevice();
    const g1 = grantForge(a.laptop, a.id, vm.id, terms());
    expect(checkChain(a.id, a.id, { cert: a.cert, grants: [grantForge(other, a.id, vm.id, terms())] }, none)).toBe("a grant's issuer isn't the key before it");
    expect(checkChain(a.id, a.id, { cert: a.cert, grants: [{ ...g1, body: { ...g1.body, perms: "contents:write administration:write" } }] }, none)).toBe("a grant isn't signed by its issuer");
    expect(checkChain(a.id, a.id, { cert: a.cert, grants: [g1] }, none, g1.body.expires)).toBe("a grant has expired");
    // A second grant must name the first.
    expect(checkChain(a.id, a.id, { cert: a.cert, grants: [g1, grantForge(vm, a.id, other.id, terms())] }, none)).toBe("a grant doesn't name the grant before it");
    let chain = [g1];
    let holder = vm;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const next = newDevice();
      chain = [...chain, grantForge(holder, a.id, next.id, terms(), chain[chain.length - 1])];
      holder = next;
    }
    expect(checkChain(a.id, a.id, { cert: a.cert, grants: chain }, none)).toBe(`at most ${MAX_CHAIN} grants`);
  });

  it("revoking a device in the chain, or a grant, ends it", () => {
    const a = account();
    const vm = newDevice();
    const sub = newDevice();
    const g1 = grantForge(a.laptop, a.id, vm.id, terms());
    const g2 = grantForge(vm, a.id, sub.id, terms(), g1);
    const chain = { cert: a.cert, grants: [g1, g2] };
    expect(checkChain(a.id, a.id, chain, { devices: [revoke(a.keys, vm.id)], grant: () => false })).toBe("a grant's holder is revoked");
    expect(checkChain(a.id, a.id, chain, { devices: [revoke(a.keys, a.laptop.id)], grant: () => false })).toBe("device is revoked");
    const h1 = forgeGrantHash(g1.body);
    expect(checkChain(a.id, a.id, chain, { devices: [], grant: (h, by) => h === h1 && by === a.laptop.id })).toBe("a grant is revoked");
  });

  it("a relay-only device holds grants and is never the account", () => {
    const a = account();
    const fleetd = newDevice();
    const relay = certify(a.keys, fleetd, "fleetd", Date.now(), "relay");
    expect(typeof checkChain(a.id, a.id, { cert: relay }, none)).toBe("string");
    expect(typeof checkChain(a.id, a.id, { cert: relay, grants: [grantForge(fleetd, a.id, newDevice().id, terms())] }, none)).toBe("string");
    expect(typeof checkChain(a.id, a.id, { cert: a.cert, grants: [grantForge(a.laptop, a.id, fleetd.id, terms())] }, none)).toBe("object");
  });
});
