// End-to-end encrypted boards from the command line, for now the only
// client (see .agent/plans/e2ee.md):
//
//   corkboard-bridge e2ee init [--invite CODE | --admin] [--name NAME] [--passphrase]
//                              a new account, this machine its first device; prints
//                              the recovery phrase, once. --admin: made with this
//                              machine's sign-in (cloud.ts), an admin's, and no invite
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
//   corkboard-bridge e2ee status | revoke DEVICE
//
// The relay is CORKBOARD_CLOUD's (cloud.ts). The passphrase, when there is
// one, is CORKBOARD_E2EE_PASSPHRASE or asked for.

import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { CLOUD, token as googleToken } from "./cloud";
import { DATA_DIR } from "./dirs";
import { Keystore } from "./keystore";
import { type CardChange, type MergedCard } from "../lib/e2ee/merge";
import { accountKeys, newRoot, objectId, objectKey } from "../lib/e2ee/keys";
import { certify, checkCert, creation, newDevice, revoke, type Device } from "../lib/e2ee/device";
import { approve, pairNew } from "../lib/e2ee/pairing";
import { fromPhrase, toPhrase } from "../lib/e2ee/phrase";
import { Relay } from "../lib/e2ee/relay";
import { Replica } from "../lib/e2ee/sync";
import { type DeviceCert, type Signed, normalizeCode, showCode } from "../lib/e2ee/wire";

const USAGE = "usage: corkboard-bridge e2ee init|recover|pair|approve CODE|push-board KEY|pull-board KEY|status|revoke DEVICE";

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
  if (d.relay !== CLOUD) throw new Error(`this machine's account is on ${d.relay}, not ${CLOUD} (CORKBOARD_CLOUD)`);
  const root = await store.root(passphrase(args, false));
  return { ...d, root, relay: relayFor(d.device, d.cert) };
}

function refuseTwice() {
  if (store.exists()) throw new Error(`this machine is already in an account (${store.dir}); it has one at a time`);
}

async function keep(root: Uint8Array, device: Device, cert: Signed<DeviceCert>, name: string, args: string[]) {
  await store.saveRoot(root, passphrase(args, true));
  store.saveDevice(CLOUD, name, device, cert);
}

async function init(args: string[]) {
  refuseTwice();
  const name = option(args, "--name") ?? hostname();
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
  console.log("Its recovery phrase, which is the only way back in with every device gone. Write it down; it isn't shown again:\n");
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
type PlainCard = { id: string; log?: { at: string; who: string; note: string }[]; [k: string]: unknown };

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

// What the replica lacks of a card: the fields that differ, and the log
// entries it doesn't have, so pushing a board twice adds nothing.
function changesFor(card: PlainCard, had: MergedCard | undefined): CardChange[] {
  const { id, log = [], version: _v, waiting_on: _w, ...fields } = card;
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (JSON.stringify(had?.[k]) !== JSON.stringify(v)) set[k] = v;
  const seen = new Set((had?.log ?? []).map((e) => JSON.stringify([e.at, e.who, e.note])));
  const out: CardChange[] = Object.keys(set).length ? [{ t: "card", card: id, set }] : [];
  for (const e of log) if (!seen.has(JSON.stringify([e.at, e.who, e.note]))) out.push({ t: "log", card: id, entry: { at: e.at, who: e.who, note: e.note } });
  return out;
}

async function replicaOf(me: Awaited<ReturnType<typeof signedIn>>, key: string) {
  const object = objectId(me.root, "board", key);
  return Replica.open({ transport: me.relay, key: objectKey(me.root, "board", key), object, device: me.device.id, store: store.replica(object) });
}

async function pushBoard(args: string[]) {
  const key = args[1];
  if (!key) throw new Error("push-board takes a board's key");
  const me = await signedIn(args);
  const rep = await replicaOf(me, key);
  await rep.pull();
  const had = new Map(rep.cards().map((c) => [c.id, c]));
  const changes = (await plainBoard(key, args.includes("--local"))).flatMap((c) => changesFor(c, had.get(c.id)));
  if (changes.length) await rep.change(...changes);
  const pushed = await rep.push();
  console.error(`${key}: ${pushed} ops pushed (${rep.cards().length} cards), as ${rep.object}`);
}

async function pullBoard(args: string[]) {
  const key = args[1];
  if (!key) throw new Error("pull-board takes a board's key");
  const me = await signedIn(args);
  const rep = await replicaOf(me, key);
  await rep.sync();
  if (rep.rejected.length) console.error(`${rep.rejected.length} ops didn't open and were skipped: ${rep.rejected.slice(0, 5).join(", ")}`);
  console.log(JSON.stringify(rep.cards(), null, 2));
}

async function status(args: string[]) {
  const d = store.device();
  if (!d) return console.log("This machine isn't in an encrypted account.");
  console.log(`account  ${d.cert.body.account}\ndevice   ${d.device.id} (${d.name})\nrelay    ${d.relay}\nkey      ${store.needsPassphrase() ? "under a passphrase" : "in the keychain (a file)"}`);
  if (d.relay !== CLOUD) return;
  const me = await signedIn(args);
  const revoked = await me.relay.revoked();
  const problem = checkCert(d.cert.body.account, d.cert, revoked as never);
  console.log(`state    ${problem ?? "signed in"}`);
}

async function revokeDevice(args: string[]) {
  const device = args[1];
  if (!device) throw new Error("revoke takes a device's id (status shows this one's)");
  const me = await signedIn(args);
  if (device === me.device.id && !yes("That's this machine. Revoke it anyway?")) return;
  await me.relay.revoke(revoke(accountKeys(me.root), device));
  console.log(`Revoked ${device}.`);
}

export async function cli(args: string[]) {
  const commands: Record<string, (a: string[]) => Promise<void>> = {
    init,
    recover,
    pair,
    approve: approveCode,
    "push-board": pushBoard,
    "pull-board": pullBoard,
    status,
    revoke: revokeDevice,
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
