// End-to-end encrypted boards from the command line, for now the only
// client (see .agent/plans/e2ee.md):
//
//   corkboard-bridge e2ee init [--invite CODE | --admin | --local] [--name NAME] [--passphrase]
//                              a new account, this machine its first device; prints
//                              the recovery phrase, once. --admin: made with this
//                              machine's sign-in (cloud.ts), an admin's, and no invite.
//                              --local: on this machine only, with no relay, until publish
//   corkboard-bridge e2ee publish [--invite CODE | --admin]
//                              an account made --local, onto the relay, and every change
//                              it kept meanwhile pushed
//   corkboard-bridge e2ee recover [--name NAME] [--passphrase]
//                              this machine into the account whose phrase is on stdin
//   corkboard-bridge e2ee pair [--name NAME] [--passphrase]
//                              this machine into an account another device approves
//   corkboard-bridge e2ee approve CODE
//                              let a pairing device in, on a device that's in
//   corkboard-bridge e2ee push-board KEY [--local]
//                              a board, encrypted into its log on the relay: the Worker's
//                              plaintext board by that key, or --local, the card files'
//   corkboard-bridge e2ee pull-board KEY
//                              the board from its log, decrypted and merged, as JSON
//   corkboard-bridge e2ee share KIND NAME ACCOUNT [read|write] | unshare KIND NAME ACCOUNT
//                              an object of this account's (a board, brain or memory)
//                              shared with another account, or no longer
//   corkboard-bridge e2ee shared
//                              what's shared with this account, and what it shares
//   corkboard-bridge e2ee compact [KIND NAME]
//                              the account's logs (or one) sealed into a snapshot, where
//                              they've grown enough (or that one regardless)
//   corkboard-bridge e2ee rotate
//                              the account onto a new root and key, this machine its only
//                              device (the others pair again); prints the new phrase
//   corkboard-bridge e2ee rotated
//                              this machine onto the new root another device rotated to
//   corkboard-bridge e2ee status | phrase | revoke DEVICE
//   corkboard-bridge e2ee relay-device DEVICE BOX [--name NAME]
//                              a relay-only device's cert (fleetd's: `corkboard-fleet device` prints
//                              its keys), as JSON: it opens channels to the account's nodes
//                              and is their owner there, but never has the root; revoke
//                              ends it as any device's
//   corkboard-bridge e2ee nodes | leader [this|DEVICE|none]
//                              the account's nodes connected to the relay, and the leader,
//                              the one its tunnel (<relay>/n/<handle>) goes to first
//   corkboard-bridge e2ee approve-connector
//                              a one-time code (ten minutes) for approving a connector
//                              at this machine's node's /authorize (bridge/node/)
//   corkboard-bridge e2ee move-memory [--dry-run] [--passphrase]
//                              this sign-in's memory off the Worker and into the account's
//                              brains, the account made or published first if it must be;
//                              --dry-run copies it and leaves the Worker's (node/move.ts)
//   corkboard-bridge e2ee move-boards [--dry-run] [--passphrase]
//                              this sign-in's boards off the Worker, cards, logs and files,
//                              into the account's board replicas, the same way
//   corkboard-bridge e2ee move-plans [--dry-run] [--passphrase]
//                              the day plans and the chat into the account's day
//                              object; the calendar stays the Worker's, lent to the node
//
// The relay is the server the bridge uses (cloud.ts). The passphrase, when there is
// one, is CORKBOARD_E2EE_PASSPHRASE or asked for.

import { existsSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CLOUD, signedIn as cloudSignedIn, token as googleToken } from "./cloud";
import { DATA_DIR } from "./dirs";
import { Keystore } from "./keystore";
import { type PlainCard, changesFor } from "./node/board";
import { type ObjectKind, accountKeys, newRoot, objectId, objectKey } from "../lib/e2ee/keys";
import { certify, checkCert, creation, newDevice, revoke, type Device } from "../lib/e2ee/device";
import { approve, pairNew } from "../lib/e2ee/pairing";
import { fromPhrase, toPhrase } from "../lib/e2ee/phrase";
import { type Nodes, Relay } from "../lib/e2ee/relay";
import { type IndexEntry, checkRotated, entries, indexId, indexKey, keyOf, remember, rotate, share, sharedWithMe, unshare } from "../lib/e2ee/sharing";
import { Replica, memoryStore } from "../lib/e2ee/sync";
import { type DeviceCert, type Role, type Signed, KEY, ROLES, fromB64url, normalizeCode, showCode } from "../lib/e2ee/wire";

const USAGE =
  "usage: corkboard-bridge e2ee init|publish|recover|pair|approve CODE|push-board KEY|pull-board KEY|share KIND NAME ACCOUNT [ROLE]|unshare KIND NAME ACCOUNT|shared|compact [KIND NAME]|rotate|rotated|status|phrase|revoke DEVICE|relay-device DEVICE BOX [--name NAME]|nodes|leader [this|DEVICE|none]|approve-connector|move-memory [--dry-run]|move-boards [--dry-run]|move-plans [--dry-run]";

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const store = new Keystore();

function passphrase(args: string[], making: boolean): string | undefined {
  if (process.env.CORKBOARD_E2EE_PASSPHRASE) return process.env.CORKBOARD_E2EE_PASSPHRASE;
  if (making ? !args.includes("--passphrase") : !store.needsPassphrase()) return;
  const p = prompt("Passphrase for this machine's copy of the account key:") ?? "";
  if (!p) throw new Error("no passphrase given");
  return p;
}

const yes = (q: string) => /^y(es)?$/i.test((prompt(`${q} [y/N]`) ?? "").trim());

function relayFor(device?: Device, cert?: Signed<DeviceCert>) {
  return new Relay({ origin: CLOUD, device, cert, token: device ? store.token() : undefined, onToken: (t) => store.saveToken(t) });
}

// This machine as a device of its account, and the root, unlocked.
async function signedIn(args: string[]) {
  const d = store.device();
  if (!d || !store.exists()) throw new Error("this machine isn't in an encrypted account: corkboard-bridge e2ee init, recover or pair");
  if (d.relay === null) throw new Error(`this machine's account is only on this machine; corkboard-bridge e2ee publish puts it on ${CLOUD}`);
  if (d.relay !== CLOUD) throw new Error(`this machine's account is on ${d.relay}, not ${CLOUD} (CORKBOARD_CLOUD)`);
  const pass = passphrase(args, false);
  const root = await store.root(pass);
  return { ...d, root, pass, relay: relayFor(d.device, d.cert) };
}

function refuseTwice() {
  if (store.exists()) throw new Error(`this machine is already in an account (${store.dir}); it has one at a time`);
}

async function keep(root: Uint8Array, device: Device, cert: Signed<DeviceCert>, name: string, args: string[], relay: string | null = CLOUD) {
  await store.saveRoot(root, passphrase(args, true));
  store.saveDevice(relay, name, device, cert);
}

// An account on this machine only, its key in the keychain: what init
// --local makes, and the bridge when it starts signed out with none (node/app.ts).
export async function localAccount(name = hostname(), pass?: string) {
  refuseTwice();
  const root = newRoot();
  const keys = accountKeys(root);
  const device = newDevice();
  await store.saveRoot(root, pass);
  store.saveDevice(null, name, device, certify(keys, device, name));
  return { root, account: keys.id };
}

async function init(args: string[]) {
  refuseTwice();
  const name = option(args, "--name") ?? hostname();
  if (args.includes("--local")) {
    const { root, account } = await localAccount(name, passphrase(args, true));
    console.log(`Made the account ${account} on this machine (${name}) only; corkboard-bridge e2ee publish puts it on ${CLOUD}.\n`);
    return printPhrase(root, "Its recovery phrase, which is the only way back in with every device gone. Write it down; it isn't shown again:");
  }
  const root = newRoot();
  const keys = accountKeys(root);
  const device = newDevice();
  const cert = certify(keys, device, name);
  const relay = relayFor(device, cert);
  const invite = option(args, "--invite") ?? null;
  await relay.createAccount(creation(keys, CLOUD, invite), cert, args.includes("--admin") ? await googleToken() : undefined);
  await keep(root, device, cert, name, args);
  await relay.signIn();
  console.log(`Made the account ${keys.id} on ${CLOUD}, with this machine (${name}) as its first device.\n`);
  printPhrase(root, "Its recovery phrase, which is the only way back in with every device gone. Write it down; it isn't shown again:");
}

// An account made --local, made at the relay with the keys it already has,
// and each object's queue pushed: the index first, then what it lists. The
// replicas on disk don't change; they only have somewhere to sync now.
async function publish(args: string[]) {
  const d = store.device();
  if (!d || !store.exists()) throw new Error("this machine isn't in an encrypted account: corkboard-bridge e2ee init --local");
  if (d.relay !== null) throw new Error(`this machine's account is on ${d.relay} already`);
  const root = await store.root(passphrase(args, false));
  const keys = accountKeys(root);
  const relay = relayFor(d.device, d.cert);
  await relay.createAccount(creation(keys, CLOUD, option(args, "--invite") ?? null), d.cert, args.includes("--admin") ? await googleToken() : undefined);
  store.saveDevice(CLOUD, d.name, d.device, d.cert);
  await relay.signIn();
  const me = await signedIn(args);
  const object = indexId(me.root);
  const index = await Replica.open({ transport: me.relay, key: indexKey(me.root), object, device: me.device.id, store: store.replica(object) });
  let ops = await index.push();
  for (const e of entries(index)) {
    const rep = await objectOf(me, index, e.kind, e.name);
    const n = await rep.push();
    ops += n;
    console.log(`${e.kind.padEnd(6)} ${e.name.padEnd(30)} ${n} changes`);
  }
  console.log(`\nThe account ${keys.id} is on ${CLOUD} now, with ${ops} changes pushed.`);
}

function printPhrase(root: Uint8Array, heading: string) {
  console.log(heading + "\n");
  const words = toPhrase(root).split(" ");
  for (let i = 0; i < words.length; i += 6) console.log("  " + words.slice(i, i + 6).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`).join(" "));
  console.log();
}

async function recover(args: string[]) {
  refuseTwice();
  const name = option(args, "--name") ?? hostname();
  console.log("The recovery phrase, on one line or several, then an empty line:");
  let phrase = "";
  for await (const line of console) {
    if (!line.trim()) break;
    phrase += " " + line;
  }
  const root = fromPhrase(phrase);
  const keys = accountKeys(root);
  const device = newDevice();
  const cert = certify(keys, device, name);
  await relayFor(device, cert).signIn();
  await keep(root, device, cert, name, args);
  console.log(`This machine (${name}) is a device of ${keys.id} again.`);
}

async function pair(args: string[]) {
  refuseTwice();
  const name = option(args, "--name") ?? hostname();
  const device = newDevice();
  const got = await pairNew(relayFor(), device, name, {
    show: (code, qr) => console.log(`On a device that's in the account:\n\n  corkboard-bridge e2ee approve ${showCode(code)}\n\n(or scan: ${qr})\nWaiting...`),
    confirm: async (sas) => yes(`The other device shows a six-digit code. Is it ${sas}?`),
  });
  await keep(got.root, device, got.cert, name, args);
  await relayFor(device, got.cert).signIn();
  console.log(`This machine (${name}) is a device of ${got.cert.body.account}.`);
}

async function approveCode(args: string[]) {
  const code = normalizeCode(args[1] ?? "");
  if (!code) throw new Error("approve takes the code the new device shows, XXXXX-XXXXX");
  const me = await signedIn(args);
  const cert = await approve(me.relay, me.root, code, {
    confirm: async (sas, join) => {
      console.log(`"${join.name}" (${join.device}) wants in.`);
      return yes(`Does it show ${sas}?`);
    },
  });
  console.log(`Let ${cert.body.name} in.`);
}

// A board as the Worker or the card files have it, as cards with their logs.
async function plainBoard(key: string, local: boolean): Promise<PlainCard[]> {
  if (local) {
    const dir = join(DATA_DIR, "boards", key);
    if (!existsSync(join(dir, "tasks"))) throw new Error(`no board ${key} in ${join(DATA_DIR, "boards")}`);
    // Only now: mcp/cards.ts asks git where it is when it loads.
    const { cardsOf } = await import("./import");
    return cardsOf(dir);
  }
  const res = await fetch(`${CLOUD}/api/boards/${encodeURIComponent(key)}/cards?log=1`, { headers: { Authorization: `Bearer ${await googleToken()}` } });
  const json = (await res.json().catch(() => ({}))) as PlainCard[] | { error?: string };
  if (!res.ok || !Array.isArray(json)) throw new Error(`board ${key}: ${(json as { error?: string }).error ?? res.status}`);
  return json;
}

type Me = Awaited<ReturnType<typeof signedIn>>;

// The account's id: its first key, which a rotation doesn't change. The
// relay's token says it; a cert names the key it was signed by.
async function accountId(me: Me) {
  await me.relay.token();
  return me.relay.account!;
}

// The account's index: every object it has, and the key of each on one of its own.
async function indexOf(me: Me) {
  const object = indexId(me.root);
  const index = await Replica.open({ transport: me.relay, key: indexKey(me.root), object, device: me.device.id, store: store.replica(object) });
  await index.sync();
  return index;
}

type Kind = IndexEntry["kind"];

function kindOf(kind: string | undefined): Kind {
  if (kind !== "board" && kind !== "brain" && kind !== "memory") throw new Error(`a kind is board, brain or memory, not ${kind ?? "nothing"}`);
  return kind;
}

const entryOf = (index: Replica, kind: ObjectKind, name: string) => entries(index).find((e) => e.kind === kind && e.name === name);

// One of the account's objects, under the key and epoch its index entry
// gives (a shared one keeps its id and has a key of its own), else its derived one.
async function objectOf(me: Me, index: Replica, kind: Kind, name: string) {
  const e = entryOf(index, kind, name);
  const object = e?.object ?? objectId(me.root, kind, name);
  const keyAt = async (epoch: number) => {
    await index.pull();
    const now = entryOf(index, kind, name);
    return now?.epoch === epoch ? keyOf(me.root, now) : undefined;
  };
  return Replica.open({ transport: me.relay, key: e ? keyOf(me.root, e) : objectKey(me.root, kind, name), epoch: e?.epoch ?? 0, keyOf: keyAt, object, device: me.device.id, store: store.replica(object) });
}

// Into the index the first time it's pushed, and compacted when it's grown.
async function pushed(index: Replica, rep: Replica, kind: Kind, name: string) {
  if (!entries(index).some((e) => e.object === rep.object)) {
    await remember(index, { object: rep.object, kind, name, epoch: rep.currentEpoch });
    await index.push();
  }
  if (rep.worthCompacting && (await rep.compact())) console.error(`${kind} ${name}: compacted`);
}

async function pushBoard(args: string[]) {
  const key = args[1];
  if (!key) throw new Error("push-board takes a board's key");
  const me = await signedIn(args);
  const index = await indexOf(me);
  const rep = await objectOf(me, index, "board", key);
  await rep.pull();
  const had = new Map(rep.cards().map((c) => [c.id, c]));
  const changes = (await plainBoard(key, args.includes("--local"))).flatMap((c) => changesFor(c, had.get(c.id)));
  if (changes.length) await rep.change(...changes);
  const n = await rep.push();
  await pushed(index, rep, "board", key);
  console.error(`${key}: ${n} ops pushed (${rep.cards().length} cards), as ${rep.object}`);
}

async function pullBoard(args: string[]) {
  const key = args[1];
  if (!key) throw new Error("pull-board takes a board's key");
  const me = await signedIn(args);
  const rep = await objectOf(me, await indexOf(me), "board", key);
  await rep.sync();
  if (rep.rejected.length) console.error(`${rep.rejected.length} ops didn't open and were skipped: ${rep.rejected.slice(0, 5).join(", ")}`);
  console.log(JSON.stringify(rep.cards(), null, 2));
}

// The recovery phrase again, for an account the bridge made with no one
// there to write it down.
async function phrase(args: string[]) {
  if (!store.exists()) throw new Error("this machine isn't in an encrypted account");
  printPhrase(await store.root(passphrase(args, false)), "This account's recovery phrase, the only way back in with every device gone:");
}

async function status(args: string[]) {
  const d = store.device();
  if (!d) return console.log("This machine isn't in an encrypted account.");
  const id = store.token()?.account ?? d.cert.body.account;
  console.log(`account  ${id}\ndevice   ${d.device.id} (${d.name})\nrelay    ${d.relay ?? "none: only on this machine (e2ee publish)"}\nkey      ${store.needsPassphrase() ? "under a passphrase" : "in the keychain (a file)"}`);
  if (id !== d.cert.body.account) console.log(`signs as ${d.cert.body.account} (rotated)`);
  if (d.relay !== CLOUD) return;
  const me = await signedIn(args);
  const revoked = await me.relay.revoked();
  const problem = checkCert(d.cert.body.account, d.cert, revoked as never);
  console.log(`state    ${problem ?? "signed in"}`);
}

function showNodes(n: Nodes, me: string) {
  // A device by the name it connected with, when the relay keeps names.
  const named = (d: string) => {
    const k = n.known?.find((x) => x.device === d);
    return `${k ? `${k.name} ` : ""}${d}${d === me ? " (this machine)" : ""}`;
  };
  console.log(`tunnel   ${n.url}`);
  console.log(`leader   ${n.leader ? `${named(n.leader)}${n.connected.some((c) => c.device === n.leader) ? "" : ", not connected"}` : "none: the newest connected node answers"}`);
  for (const c of n.connected) console.log(`connected ${named(c.device)} since ${new Date(c.since).toISOString()}`);
  if (!n.connected.length) console.log("connected none");
  for (const k of n.known ?? []) if (!n.connected.some((c) => c.device === k.device)) console.log(`away     ${named(k.device)}, seen ${new Date(k.seen).toISOString()}`);
}

async function listNodes(args: string[]) {
  const me = await signedIn(args);
  showNodes(await me.relay.nodes(), me.device.id);
}

async function setLeader(args: string[]) {
  const which = args[1];
  if (!which) throw new Error("leader takes this, a device's id (e2ee nodes lists them), or none");
  const me = await signedIn(args);
  showNodes(await me.relay.setLeader(which === "none" ? null : which === "this" ? me.device.id : which), me.device.id);
}

async function shareObject(args: string[]) {
  const [, k, name, member, role = "write"] = args;
  if (!name || !member) throw new Error("share takes a kind, a name and the account to share with");
  if (!ROLES.includes(role as Role)) throw new Error(`a role is ${ROLES.join(" or ")}`);
  const kind = kindOf(k);
  const me = await signedIn(args);
  const id = await accountId(me);
  const index = await indexOf(me);
  const rep = await objectOf(me, index, kind, name);
  await rep.sync();
  await share(me.relay, me.root, id, index, rep, { kind, name, member: await me.relay.accountView(member), role: role as Role });
  console.log(`Shared ${kind} ${name} with ${member} (${role}).`);
}

async function unshareObject(args: string[]) {
  const [, k, name, member] = args;
  if (!name || !member) throw new Error("unshare takes a kind, a name and the account to stop sharing with");
  const kind = kindOf(k);
  const me = await signedIn(args);
  const index = await indexOf(me);
  const rep = await objectOf(me, index, kind, name);
  await rep.sync();
  await unshare(me.relay, me.root, await accountId(me), index, rep, member);
  console.log(`${member} no longer has ${kind} ${name}; it's on a new key, which they don't get.`);
}

async function listShared(args: string[]) {
  const me = await signedIn(args);
  const id = await accountId(me);
  const { objects, bad } = await sharedWithMe(me.relay, accountKeys(me.root), id);
  console.log("Shared with this account:");
  for (const o of objects) console.log(`  ${o.kind} ${o.name}  from ${o.owner} (${o.role})`);
  if (!objects.length) console.log("  nothing");
  for (const b of bad) console.log(`  (skipped ${b})`);
  console.log("Shared by this account:");
  let any = false;
  for (const e of entries(await indexOf(me)).filter((e) => e.key)) {
    const members = [...new Map((await me.relay.grants(e.object)).map(({ grant }) => [grant.body.member, grant.body.role])).entries()];
    for (const [m, role] of members) console.log(`  ${e.kind} ${e.name}  with ${m} (${role})`);
    any ||= members.length > 0;
  }
  if (!any) console.log("  nothing");
}

async function compact(args: string[]) {
  const [, k, name] = args;
  const me = await signedIn(args);
  const index = await indexOf(me);
  const only = k ? entryOf(index, kindOf(k), name ?? "") : undefined;
  if (k && !only) throw new Error(`${k} ${name ?? ""} isn't in this account's index`);
  for (const e of only ? [only] : entries(index)) {
    const rep = await objectOf(me, index, e.kind, e.name);
    await rep.sync();
    if (!only && !rep.worthCompacting) continue;
    console.log(`${e.kind} ${e.name}: ${(await rep.compact()) ? "compacted" : "nothing to compact"}`);
  }
}

// This machine's half of a rotation: the new root kept before anything is
// sent, so a crash midway doesn't lose it; then the relay told, and kept as
// the root. Other devices' certs aren't known here, so only this one stays.
async function rotateAccount(args: string[]) {
  const me = await signedIn(args);
  const id = await accountId(me);
  if (!yes("Rotate this account onto a new root? Every other device will have to pair again, and the recovery phrase changes.")) return;
  const pass = me.pass;
  const r = await rotate(me.relay, me.root, id, me.device, [me.cert.body], {
    replica: (_root, object, key, epoch) => Replica.open({ transport: me.relay, key, epoch, object, device: me.device.id, store: memoryStore() }),
    keepRoot: (root) => store.saveRoot(root, pass, "rotating.json"),
  });
  await store.saveRoot(r.root, pass);
  store.saveDevice(CLOUD, me.name, me.device, r.cert);
  rmSync(join(store.dir, "rotating.json"), { force: true });
  await me.relay.signIn();
  console.log(`Rotated ${id} onto ${accountKeys(r.root).id}. Pair the other devices again.\n`);
  printPhrase(r.root, "The new recovery phrase; the old one no longer opens anything new. Write it down; it isn't shown again:");
}

// A device another one kept in its rotation: the new root and cert it left
// for this one, checked against the key this machine knew.
async function rotatedOnto(args: string[]) {
  const me = await signedIn(args);
  const id = store.token()?.account ?? me.cert.body.account;
  const got = checkRotated(await me.relay.rotated(id, me.device.id), me.cert.body.account, me.device);
  await store.saveRoot(got.root, me.pass);
  store.saveDevice(CLOUD, me.name, me.device, got.cert);
  await relayFor(me.device, got.cert).signIn();
  console.log(`This machine (${me.name}) is on ${id}'s new key, ${got.cert.body.account}.`);
}

async function revokeDevice(args: string[]) {
  const device = args[1];
  if (!device) throw new Error("revoke takes a device's id (status shows this one's)");
  const me = await signedIn(args);
  if (device === me.device.id && !yes("That's this machine. Revoke it anyway?")) return;
  await me.relay.revoke(revoke(accountKeys(me.root), device));
  console.log(`Revoked ${device}.`);
}

// Signed here, where the root is; the device's keys never leave its machine.
async function relayDevice(args: string[]) {
  const [, device, box] = args;
  if (!device || !KEY.test(device) || !box || !KEY.test(box)) throw new Error("relay-device takes the device's id and box key (corkboard-fleet device prints them)");
  const me = await signedIn(args);
  const cert = certify(accountKeys(me.root), { id: device, box: fromB64url(box) }, option(args, "--name") ?? "fleetd", Date.now(), "relay");
  console.log(JSON.stringify(cert));
}

// The bridge mustn't be serving a node meanwhile (serve.ts's lock), and is
// restarted after, to serve this one.
async function moveOff(args: string[], what: "memory" | "boards" | "plans") {
  if (!cloudSignedIn()) throw new Error("not signed in: corkboard-bridge login");
  const d = store.device();
  if (!d || !store.exists()) await init(args);
  else if (d.relay === null) await publish(args);
  if (store.needsPassphrase() && !process.env.CORKBOARD_E2EE_PASSPHRASE) process.env.CORKBOARD_E2EE_PASSPHRASE = passphrase(args, false);
  const { startNode } = await import("./node/serve");
  const { moveBoards, moveMemory, movePlans } = await import("./node/move");
  const n = await startNode({ port: 0, host: "127.0.0.1", origin: undefined });
  const dryRun = args.includes("--dry-run");
  const worker = async (path: string, init: RequestInit = {}) =>
    fetch(`${CLOUD}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${await googleToken()}` } });
  try {
    await (what === "memory" ? moveMemory(n, worker, { dryRun }) : what === "boards" ? moveBoards(n, worker, { dryRun }) : movePlans(n, worker, { dryRun }));
  } finally {
    await n.stop();
  }
  const It = what === "memory" ? "Memory is" : what === "boards" ? "The boards are" : "The day plans and chat are";
  console.log(
    dryRun
      ? `\nCopied into the account ${n.account}; the Worker keeps its ${what} (a dry run).`
      : `\n${It} in the account ${n.account} now, and gone from ${CLOUD}. Restart the bridge to serve ${what === "memory" ? "it" : "them"}.`,
  );
}

export async function cli(args: string[]) {
  const commands: Record<string, (a: string[]) => Promise<void>> = {
    init,
    publish,
    recover,
    pair,
    approve: approveCode,
    "push-board": pushBoard,
    "pull-board": pullBoard,
    share: shareObject,
    unshare: unshareObject,
    shared: listShared,
    compact,
    rotate: rotateAccount,
    rotated: rotatedOnto,
    status,
    phrase,
    revoke: revokeDevice,
    "relay-device": relayDevice,
    "move-memory": (a) => moveOff(a, "memory"),
    "move-boards": (a) => moveOff(a, "boards"),
    "move-plans": (a) => moveOff(a, "plans"),
    nodes: listNodes,
    leader: setLeader,
    "approve-connector": async () => console.log((await import("./node/serve")).approvalCode()),
  };
  const run = commands[args[0]];
  if (!run) {
    console.error(USAGE);
    process.exit(2);
  }
  try {
    await run(args);
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await cli(process.argv.slice(2));
