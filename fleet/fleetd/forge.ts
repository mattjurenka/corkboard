// A spawn's way onto the forge (.agent/plans/forge-keys.md): fleetd makes
// it a key at the claim, the node signs that key a grant of what its
// template's git names (bridge/node/fleet.ts's gitGrant). The key stays on
// the host: the guest's git goes to fleetd on its gateway (slotForge), which
// carries each request to the leader's forge with the grant, so the guest
// holds nothing (fleet/guest/slot.nix). The grant lasts a day; one still
// running asks the node for another before then.

import { ed25519 } from "@noble/curves/ed25519.js";
import { type Chain, type Scope, type Signer, ANSWER_HEADER, CHAIN_HEADER, channelAnswer, refAllowed, repoAllowed } from "../../lib/e2ee/forge";
import { b64url, fromB64url, utf8 } from "../../lib/e2ee/wire";
import type { Manifest, Spawn } from "./fleet";

// What a spawn keeps of its grant: the node's answer, and its key's secret.
export type Git = { account: string; gate: string; chain: Chain; key: string };

// No sooner than this after a regrant that failed.
const RETRY_MS = 60_000;
// A new grant this long before the last one ends.
const REGRANT_MS = 2 * 3600_000;

export function newHolder(): { id: string; key: string } {
  const secret = ed25519.utils.randomSecretKey();
  return { id: b64url(ed25519.getPublicKey(secret)), key: b64url(secret) };
}

export function signerOf(git: Git): Signer {
  const secret = fromB64url(git.key);
  const pub = ed25519.getPublicKey(secret);
  return { id: b64url(pub), sign: { secret, public: pub } };
}

// The chain's last holder, which must be this key's.
const holderOf = (git: Git) => git.chain.grants?.at(-1)?.body.holder;

export class GitGrants {
  private by = new Map<string, { tried?: number; regrantTried?: number }>();

  // regrant asks the node for another grant to the same key; save keeps
  // the spawn with it.
  constructor(
    private regrant: (s: Spawn, holder: string) => Promise<Omit<Git, "key"> | undefined>,
    private save?: (s: Spawn) => void,
  ) {}

  // A new grant, when this one's nearly over.
  async keep(s: Spawn, now = Date.now()) {
    const git = s.remote?.git;
    if (!git) return;
    const was = this.by.get(s.id) ?? {};
    this.by.set(s.id, was);
    const signer = signerOf(git);
    if (holderOf(git) !== signer.id) {
      if (!was.tried) console.error(`${s.id}: the forge: its grant is another key's`);
      was.tried = now;
      return;
    }
    const ends = git.chain.grants?.at(-1)?.body.expires ?? Infinity;
    if (ends - now >= REGRANT_MS || (was.regrantTried && now - was.regrantTried < RETRY_MS)) return;
    try {
      const next = await this.regrant(s, signer.id);
      if (next?.chain.grants?.at(-1)?.body.holder !== signer.id) throw new Error("the node gave no new grant");
      s.remote!.git = { ...next, key: git.key };
      this.save?.(s);
      delete was.regrantTried;
    } catch (e) {
      if (!was.regrantTried) console.error(`${s.id}: a new git grant: ${(e as Error).message}`);
      was.regrantTried = now;
    }
  }

  // Each running spawn's, and those over forgotten.
  async step(m: Manifest, all: Spawn[], now = Date.now()) {
    const running = new Set<string>();
    for (const s of all) {
      if (s.state !== "running" || !s.remote?.git || !s.slot || !m.slots[s.slot]) continue;
      running.add(s.id);
      await this.keep(s, now);
    }
    for (const id of this.by.keys()) if (!running.has(id)) this.by.delete(id);
  }
}

// The forge for a slot's guest (forge-on-leader.md, piece 3): fleetd
// listens on each slot's host address, and carries what the guest asks to
// the leader's /forge/ on its node channel (node.ts), with the running
// spawn's chain and its key's answer for fleetd's device, so the guest
// holds nothing. A request from anywhere but the slot's guest, or with no
// spawn there that has a grant, is refused.
export const FORGE_PORT = 8890;
const GIT_HEADERS = ["content-type", "accept", "git-protocol", "content-encoding"];

// device: fleetd's own (the channel's); send: a request to the node.
export function slotForge(o: { manifest: () => Manifest; spawns: () => Spawn[]; device: () => string; send: (path: string, init: RequestInit) => Promise<Response> }) {
  return async (slot: string, req: Request, from: string | undefined): Promise<Response> => {
    const sl = o.manifest().slots[slot];
    if (!sl || from?.replace(/^::ffff:/, "") !== sl.guestAddress) return new Response("not this slot's guest", { status: 403 });
    const s = o.spawns().find((x) => x.state === "running" && x.slot === slot);
    const git = s?.remote?.git;
    if (!git) return new Response("this slot's spawn has no git access", { status: 403 });
    const headers = new Headers();
    for (const h of GIT_HEADERS) {
      const v = req.headers.get(h);
      if (v) headers.set(h, v);
    }
    headers.set(CHAIN_HEADER, b64url(utf8(JSON.stringify(git.chain))));
    headers.set(ANSWER_HEADER, channelAnswer(signerOf(git), o.device()));
    const url = new URL(req.url);
    const hasBody = !/^(GET|HEAD)$/i.test(req.method);
    try {
      return await o.send(`/forge${url.pathname}${url.search}`, { method: req.method, headers, ...(hasBody && { body: req.body, duplex: "half" }), signal: req.signal } as RequestInit);
    } catch (e) {
      return new Response(`the forge: ${(e as Error).message}`, { status: 502 });
    }
  };
}

// A listener on each slot's host address (its tap's, up from boot), tried
// again at each tick until it's there.
export class SlotForges {
  private servers = new Map<string, ReturnType<typeof Bun.serve>>();
  private failed = new Set<string>();

  constructor(
    private handle: ReturnType<typeof slotForge>,
    private port = FORGE_PORT,
  ) {}

  keep(m: Manifest) {
    for (const [name, sl] of Object.entries(m.slots)) {
      if (!sl.hostAddress || this.servers.has(name)) continue;
      try {
        this.servers.set(name, Bun.serve({ hostname: sl.hostAddress, port: this.port, idleTimeout: 255, fetch: (req, srv) => this.handle(name, req, srv.requestIP(req)?.address) }));
        this.failed.delete(name);
      } catch (e) {
        if (!this.failed.has(name)) console.error(`${name}: the forge on ${sl.hostAddress}:${this.port}: ${(e as Error).message}`);
        this.failed.add(name);
      }
    }
  }

  stop() {
    for (const s of this.servers.values()) s.stop(true);
    this.servers.clear();
  }
}

// What the agent is told of it.
export function gitNote(s: Spawn): string {
  const g = s.remote?.git?.chain.grants?.at(-1)?.body;
  if (!g) return "";
  const perms = g.perms ? g.perms.split(" ").join(", ") : "read only";
  const work = s.forge ? ` Your work dir's origin is ${s.forge.repo} there, on branch ${s.forge.branch}: push your work to it.` : "";
  const pulls = /(^| )pull_requests:write( |$)/.test(g.perms)
    ? ` To open a pull request, POST {"head", "base", "title", "body"} as JSON to http://fleet-gateway:${FORGE_PORT}/api/v1/repos/<owner>/<repo>/pulls (Forgejo's API, no token).`
    : "";
  return `\n\nYou have git access at http://fleet-gateway:${FORGE_PORT}/ (the forge's own URLs go there too) to ${g.repos.split(" ").join(", ")} (${perms}${g.refs ? `; pushes only to ${g.refs.split(" ").join(", ")}` : ""}); it needs no credentials.${work}${pulls}`;
}

// The forge's repo a spawn's repo is a clone of, by its origin (the
// bridge's /forge/ loopback, or the forge's own host), when the grant
// covers it: the guest works on that, on the spawn's own branch, rather
// than only the bundle.
export function forgeOrigin(s: Spawn, origin: string, forgeHost = "git.corkboard.fyi"): Spawn["forge"] {
  const g = s.remote?.git?.chain.grants?.at(-1)?.body;
  if (!g) return;
  const host = forgeHost.replaceAll(".", "\\.");
  const m = new RegExp(`(?:/forge/|^https?://${host}/|^(?:ssh://)?git@${host}[:/])([\\w.-]+)/([\\w.-]+?)(?:\\.git)?/?$`).exec(origin.trim());
  if (!m) return;
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  const scope = { repos: g.repos.split(" "), refs: g.refs?.split(" ") ?? null } as Scope;
  const branch = `agent/${s.id}/work`;
  if (!repoAllowed(scope, m[1], m[2]) || !refAllowed(scope, `refs/heads/${branch}`)) return;
  return { repo, branch, url: `http://fleet-gateway:${FORGE_PORT}/${repo}.git` };
}
