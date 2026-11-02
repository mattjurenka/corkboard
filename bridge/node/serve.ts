// corkboard-bridge serve: the node (see .agent/plans/e2ee.md, "The node").
// Headless: this machine signs in as its device of the encrypted account,
// keeps decrypted replicas of the boards and brains its index lists (or
// of those it's given), and serves /mcp (for claude.ai and Claude Code,
// with its own OAuth) and the phone's API, on plain HTTP behind Tailscale
// Funnel or Caddy.
//
//   corkboard-bridge serve [--port 8787] [--host 127.0.0.1] [--origin https://NAME]
//                          [--board KEY]... [--brain NAME]... [--timezone ZONE]
//   corkboard-bridge serve token [--name NAME] [--days 365] [--scope owner|assistant]
//                          a bearer for the phone's API, printed once
//   corkboard-bridge serve grants | revoke GRANT
//   corkboard-bridge serve calendar-login [--client-id ID --client-secret SECRET]
//                          [--calendar ID] [--timezone ZONE] | --file PATH
//   corkboard-bridge e2ee approve-connector
//                          a one-time code to approve a connector with at /authorize
//
// <state>/node/ has config.json (boards, brains, origin, port, host,
// timezone: what the flags add to), oauth.json and calendar.json. Boards
// and brains given narrow the index to them. The account's passphrase, if
// it has one, is CORKBOARD_E2EE_PASSPHRASE.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOUD } from "../cloud";
import { STATE_DIR } from "../dirs";
import { Keystore } from "../keystore";
import { Relay } from "../../lib/e2ee/relay";
import { indexId, indexKey } from "../../lib/e2ee/sharing";
import { Replica } from "../../lib/e2ee/sync";
import { listObjects } from "./objects";
import { Replicas } from "./replicas";
import { Data } from "./data";
import { Search } from "./search";
import { OAuthStore, SCOPES, type Scope } from "./oauth";
import { node } from "./server";
import { loadCalendar, login, saveCalendar } from "./calendar";

export const NODE_DIR = join(STATE_DIR, "node");
const oauthStore = () => new OAuthStore(join(NODE_DIR, "oauth.json"));
const calendarPath = join(NODE_DIR, "calendar.json");

type Config = { boards?: string[]; brains?: string[]; origin?: string; port?: number; host?: string; timezone?: string };

const options = (args: string[], name: string) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
const option = (args: string[], name: string) => options(args, name).at(-1);

function config(): Config {
  try {
    return JSON.parse(readFileSync(join(NODE_DIR, "config.json"), "utf8")) as Config;
  } catch {
    return {};
  }
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

// What `e2ee approve-connector` prints, and serve as it starts.
export const approvalCode = () => oauthStore().newApproval();

async function run(args: string[]) {
  const c = config();
  const store = new Keystore();
  const d = store.device();
  if (!d || !store.exists()) throw new Error("this machine isn't in an encrypted account: corkboard-bridge e2ee init, recover or pair");
  if (d.relay !== CLOUD) throw new Error(`this machine's account is on ${d.relay}, not ${CLOUD} (CORKBOARD_CLOUD)`);
  if (store.needsPassphrase() && !process.env.CORKBOARD_E2EE_PASSPHRASE) throw new Error("the account key is under a passphrase: set CORKBOARD_E2EE_PASSPHRASE");
  const root = await store.root(process.env.CORKBOARD_E2EE_PASSPHRASE);
  const relay = new Relay({ origin: CLOUD, device: d.device, cert: d.cert, token: store.token(), onToken: (t) => store.saveToken(t) });
  await relay.token();

  const index = await Replica.open({ transport: relay, key: indexKey(root), object: indexId(root), device: d.device.id, store: store.replica(indexId(root)) });
  await index.pull().catch((e) => console.error(`node: reading the index: ${(e as Error).message}`));
  const objects = listObjects(root, { boards: [...(c.boards ?? []), ...options(args, "--board")], brains: [...(c.brains ?? []), ...options(args, "--brain")] }, index);
  if (!objects.length) console.error("node: the index lists no boards or brains, and none were given (--board KEY, --brain NAME, or config.json); serving nothing");
  const replicas = await Replicas.open({ objects, transport: relay, device: d.device.id, store: (o) => store.replica(o), index });
  await replicas.start();
  const data = new Data(replicas, option(args, "--timezone") ?? c.timezone ?? localZone());
  const search = new Search(data);
  const port = Number(option(args, "--port") ?? c.port ?? 8787);
  const hostname = option(args, "--host") ?? c.host ?? "127.0.0.1";
  const origin = option(args, "--origin") ?? c.origin;
  const server = Bun.serve({ port, hostname, idleTimeout: 255, fetch: node({ data, search, oauth: oauthStore(), origin, calendar: () => loadCalendar(calendarPath) }) });

  for (const s of replicas.status()) console.log(`${s.kind.padEnd(5)} ${s.name.padEnd(30)} ${String(s.records).padStart(5)} records  ${s.error ?? "synced"}`);
  console.log(`\nnode on http://${hostname}:${server.port}${origin ? `, as ${origin}` : ""}, account ${d.cert.body.account}`);
  console.log(`approval code (10 minutes, once): ${approvalCode()}`);

  const quit = async () => {
    server.stop();
    await replicas.stop();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  await new Promise(() => {});
}

function mintToken(args: string[]) {
  const scope = (option(args, "--scope") ?? "owner") as Scope;
  if (!SCOPES.includes(scope)) throw new Error(`--scope is one of ${SCOPES.join(", ")}`);
  const days = Number(option(args, "--days") ?? 365);
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days is a number of days");
  console.log(oauthStore().mint(option(args, "--name") ?? "phone", days, scope));
}

function grants() {
  for (const g of oauthStore().grants()) console.log(`${g.id}  ${g.scope.padEnd(9)} ${new Date(g.created).toISOString().slice(0, 10)}  ${g.tokens} tokens  ${g.name}`);
}

async function calendarLogin(args: string[]) {
  const file = option(args, "--file");
  if (file) {
    const f = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    const refresh = f.refresh ?? f.refresh_token;
    if (!f.client_id || !f.client_secret || !refresh || !f.calendar) throw new Error("the file needs client_id, client_secret, refresh_token and calendar");
    saveCalendar(calendarPath, { client_id: f.client_id, client_secret: f.client_secret, refresh, calendar: f.calendar, timezone: f.timezone ?? option(args, "--timezone") ?? localZone() });
    return console.log(`The calendar ${f.calendar} is the node's to write.`);
  }
  const client_id = option(args, "--client-id") ?? process.env.GOOGLE_CLIENT_ID;
  const client_secret = option(args, "--client-secret") ?? process.env.GOOGLE_CLIENT_SECRET;
  if (!client_id || !client_secret) throw new Error("calendar-login needs a Google OAuth desktop client: --client-id and --client-secret (or GOOGLE_CLIENT_ID/SECRET)");
  const calendar = await login({ client_id, client_secret, calendar: option(args, "--calendar"), timezone: option(args, "--timezone") ?? config().timezone ?? localZone(), path: calendarPath });
  console.log(`The calendar ${calendar} is the node's to write.`);
}

export async function cli(args: string[]) {
  const sub = args[0] && !args[0].startsWith("--") ? args[0] : "";
  const commands: Record<string, (a: string[]) => Promise<void> | void> = {
    "": run,
    token: mintToken,
    grants,
    revoke: (a) => console.log(oauthStore().revoke(a[1] ?? "") ? "Revoked." : "No such grant (serve grants lists them)."),
    "calendar-login": calendarLogin,
  };
  const go = commands[sub];
  if (!go) {
    console.error("usage: corkboard-bridge serve [--port N] [--host H] [--origin URL] [--board KEY]... [--brain NAME]... | token | grants | revoke GRANT | calendar-login");
    process.exit(2);
  }
  try {
    await go(args);
    process.exit(0);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await cli(process.argv.slice(2));
