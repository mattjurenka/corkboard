// Signing the bridge in to corkboard's Worker, and keeping it signed in.
//
//   bun bridge/cloud.ts login    sign in (opens the browser); once per machine
//   bun bridge/cloud.ts token    print a current access token, for curl
//   bun bridge/cloud.ts server [<url>]
//                                the server this machine uses, or set it
//   bun bridge/cloud.ts machine <environment>
//                                mint a machine token, signed in as the owner,
//                                and print the auth.json that signs a server in
//                                with it (the droplet: its own environment's
//                                fleet and sessions, not the laptop's)
//
// The bridge is an ordinary OAuth client of the Worker: it registers itself,
// then signs in with PKCE through a one-shot server on a loopback port, the
// way RFC 8252 has native apps do it. What it gets is kept in
// corkboard's state directory (dirs.ts), as auth.json, readable only by this user, and
// token() refreshes it as it expires.
//
// The server, the Worker's origin: CORKBOARD_CLOUD, else the one set with
// `server <url>` (server.json in the state directory), else corkboard.fyi's.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "./dirs";

const AUTH = join(STATE_DIR, "auth.json");
const SERVER = join(STATE_DIR, "server.json");
const DEFAULT_CLOUD = "https://portal.corkboard.fyi";

function kept(): string | undefined {
  try {
    return (JSON.parse(readFileSync(SERVER, "utf8")) as { url?: string }).url;
  } catch {}
}

export const CLOUD = (process.env.CORKBOARD_CLOUD ?? kept() ?? DEFAULT_CLOUD).replace(/\/$/, "");

// Sets the server for the bridges started after this; "" goes back to the
// default. A sign-in is the server's, so one elsewhere needs `login` again.
export function setServer(url: string) {
  if (!url) return rmSync(SERVER, { force: true });
  const u = new URL(url);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") throw new Error(`corkboard: ${url} isn't https`);
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SERVER, JSON.stringify({ url: u.origin }) + "\n");
}

type OAuth = { cloud: string; client_id: string; access_token: string; refresh_token: string; expires_at: number };
// A machine's has only its token, which lasts until it's revoked.
type Auth = OAuth | { cloud: string; token: string };

const b64url = (b: Buffer) => b.toString("base64url");

function save(auth: Auth) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${AUTH}.tmp`;
  writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, AUTH);
}

function load(): Auth | undefined {
  try {
    const auth = JSON.parse(readFileSync(AUTH, "utf8")) as Auth;
    return auth.cloud === CLOUD ? auth : undefined;
  } catch {
    return undefined;
  }
}

async function tokens(body: Record<string, string>) {
  const res = await fetch(`${CLOUD}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`corkboard: ${json.error_description ?? json.error ?? res.status}`);
  return json as { access_token: string; refresh_token: string; expires_in: number };
}

export async function login(): Promise<void> {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  let done!: (code: string) => void, failed!: (e: Error) => void;
  const got = new Promise<string>((res, rej) => ((done = res), (failed = rej)));
  // The answer arrives at the loopback server, or pasted in: a browser that
  // can't reach this process (a sandbox, another machine) still ends on the
  // callback address, and the code in it is only good with this process's
  // PKCE verifier.
  const answer = (url: URL) => {
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state) failed(new Error("corkboard: sign-in answered for another request"));
    else if (error || !code) failed(new Error(`corkboard: sign-in ${error ?? "failed"}`));
    else done(code);
    return !error && !!code;
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/callback") return new Response("not found", { status: 404 });
      const text = answer(url) ? "Signed in. You can close this tab." : "Sign-in didn't complete; see the terminal.";
      return new Response(`<!doctype html><meta charset="utf-8"><title>corkboard</title><body style="font:15px ui-monospace,monospace;margin:4rem auto;max-width:34rem;padding:0 16px">${text}`, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  const redirect = `http://127.0.0.1:${server.port}/callback`;

  try {
    // A fresh registration per sign-in: the loopback port is new each time.
    const reg = await fetch(`${CLOUD}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: `corkboard bridge (${hostname()})`,
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    if (reg.status !== 201) throw new Error(`corkboard: couldn't register (${reg.status}): ${await reg.text()}`);
    const { client_id } = (await reg.json()) as { client_id: string };

    const url = new URL(`${CLOUD}/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: redirect,
      scope: "owner",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    console.log(`Opening the browser to sign in. If it doesn't open, go to:\n\n  ${url}\n`);
    console.log("If the browser ends on a page that won't load, paste that page's address here.\n");
    // A machine with no browser (a server) has no xdg-open: the address above is the way in.
    try {
      Bun.spawn(browse(url.toString()), { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    } catch {}
    (async () => {
      for await (const line of console) {
        const pasted = URL.canParse(line.trim()) ? new URL(line.trim()) : undefined;
        if (pasted?.pathname === "/callback") return answer(pasted);
        if (line.trim()) console.log("That isn't the callback address; it starts with " + redirect);
      }
    })();

    const timeout = setTimeout(() => failed(new Error("corkboard: sign-in timed out after 5 minutes")), 5 * 60_000);
    const code = await got.finally(() => clearTimeout(timeout));
    const t = await tokens({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id, code_verifier: verifier });
    save({ cloud: CLOUD, client_id, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 });
    console.log(`Signed in to ${CLOUD}.`);
  } finally {
    server.stop(true);
  }
}

// One refresh at a time, across every process that shares auth.json (the
// bridges, fleetd, memory-sync). Refresh tokens rotate, and the Worker keeps
// only the newest two: two processes refreshing the same token at once (as
// the bridge and fleetd do at boot) leave the file with whichever was saved
// last, which the other refresh may already have made worthless.
async function refreshing<T>(fn: () => Promise<T>): Promise<T> {
  const lock = `${AUTH}.lock`;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // Left by a process that died mid-refresh.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
      } catch {}
      await Bun.sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

const fresh = (auth: OAuth) => auth.expires_at - 60_000 > Date.now();

// A current access token, refreshed when it's within a minute of expiring.
// Refresh tokens rotate, so each refresh is saved before it's used.
export async function token(): Promise<string> {
  const auth = load();
  if (!auth) throw new Error(`corkboard: not signed in to ${CLOUD}; run bun bridge/cloud.ts login`);
  if ("token" in auth) return auth.token;
  if (fresh(auth)) return auth.access_token;
  return refreshing(async () => {
    // Another process may have refreshed while this one waited.
    const loaded = load();
    const now = loaded && !("token" in loaded) ? loaded : auth;
    if (fresh(now)) return now.access_token;
    const t = await tokens({ grant_type: "refresh_token", refresh_token: now.refresh_token, client_id: now.client_id }).catch((e) => {
      throw new Error(`${e.message}; run bun bridge/cloud.ts login`);
    });
    save({ ...now, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 });
    return t.access_token;
  });
}

// The browser on a URL, as this OS opens one. start takes its first quoted
// word for a window title, hence the "", and cmd an & for its own.
const browse = (url: string) =>
  process.platform === "darwin" ? ["open", url]
  : process.platform === "win32" ? ["cmd", "/c", "start", '""', url.replaceAll("&", "^&")]
  : ["xdg-open", url];

// login, token, server, machine: `bun bridge/cloud.ts ...`, or the compiled
// bridge's subcommands of the same names (main.ts).
export async function cli(args: string[]) {
  const command = args[0];
  try {
    if (command === "login") {
      await login();
      process.exit(0); // the paste reader would otherwise hold stdin open
    }
    else if (command === "token") console.log(await token());
    else if (command === "server") {
      if (args[1] === undefined) console.log(CLOUD);
      else {
        setServer(args[1] === "default" ? "" : args[1]);
        if (process.env.CORKBOARD_CLOUD) console.error("corkboard: CORKBOARD_CLOUD is set, and wins over this");
      }
    }
    else if (command === "machine" && args[1]) {
      const res = await fetch(`${CLOUD}/api/tokens/machine`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ environment: args[1] }),
      });
      const json = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !json.token) throw new Error(`corkboard: ${json.error ?? `HTTP ${res.status}`}`);
      console.log(JSON.stringify({ cloud: CLOUD, token: json.token }, null, 2));
    } else {
      console.error("usage: bun bridge/cloud.ts login|token|server [<url>|default]|machine <environment>");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (import.meta.main) await cli(process.argv.slice(2));
