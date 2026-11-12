// corkboard's Worker, reached as a device of this machine's encrypted
// account: what the Worker keeps for an account, which its nodes can't (the
// fleet's queue, the sessions its bridges tell of, a workspace's tickets,
// the calendar's Google connection; cloud/src/api.ts's deviceApi), with
// the token the relay gives the device (lib/e2ee/relay.ts). There's no
// other sign-in: the account is its key.
//
//   bun bridge/cloud.ts token    print a current token, for curl
//   bun bridge/cloud.ts server [<url>]
//                                the server this machine uses, or set it
//
// The server, the Worker's origin: CORKBOARD_CLOUD, else the one set with
// `server <url>` (server.json in the state directory), else corkboard.fyi's.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Relay } from "../lib/e2ee/relay";
import { STATE_DIR } from "./dirs";
import { Keystore } from "./keystore";

const SERVER = join(STATE_DIR, "server.json");
const DEFAULT_CLOUD = "https://portal.corkboard.fyi";

function kept(): string | undefined {
  try {
    return (JSON.parse(readFileSync(SERVER, "utf8")) as { url?: string }).url;
  } catch {}
}

export const CLOUD = (process.env.CORKBOARD_CLOUD ?? kept() ?? DEFAULT_CLOUD).replace(/\/$/, "");

// Sets the server for the bridges started after this; "" goes back to the
// default. An account is the relay's it was published on.
export function setServer(url: string) {
  if (!url) return rmSync(SERVER, { force: true });
  const u = new URL(url);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error(`corkboard: ${url} isn't https`);
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SERVER, JSON.stringify({ url: u.origin }) + "\n");
}

let relay: Relay | undefined;

// A current token for this machine's device, from the relay (kept in the
// keystore while it lasts, for every process of the bridge's).
export async function token(): Promise<string> {
  if (!relay) {
    const store = new Keystore();
    const d = store.device();
    if (!d) throw new Error("corkboard: this machine isn't in an account yet");
    if (d.relay === null) throw new Error(`corkboard: this machine's account is only on this machine, not on ${CLOUD}`);
    if (d.relay !== CLOUD) throw new Error(`corkboard: this machine's account is on ${d.relay}, not ${CLOUD} (CORKBOARD_CLOUD)`);
    relay = new Relay({ origin: CLOUD, device: d.device, cert: d.cert, token: store.token(), onToken: (t) => store.saveToken(t) });
  }
  return relay.token();
}

// For a test, or fleetd's own device (fleet/fleetd/node.ts): where tokens come from.
export function setRelay(r: Pick<Relay, "token"> | undefined) {
  relay = r as Relay | undefined;
}

// token, server: `bun bridge/cloud.ts ...`, or the compiled bridge's
// subcommands of the same names (main.ts).
export async function cli(args: string[]) {
  const command = args[0];
  try {
    if (command === "token") console.log(await token());
    else if (command === "server") {
      if (args[1] === undefined) console.log(CLOUD);
      else {
        setServer(args[1] === "default" ? "" : args[1]);
        if (process.env.CORKBOARD_CLOUD) console.error("corkboard: CORKBOARD_CLOUD is set, and wins over this");
      }
    } else {
      console.error("usage: bun bridge/cloud.ts token|server [<url>|default]");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await cli(process.argv.slice(2));
