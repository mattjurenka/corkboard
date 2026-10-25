// Signing the bridge in to corkboard's Worker, and keeping it signed in.
//
//   bun bridge/cloud.ts login    sign in (opens the browser); once per machine
//   bun bridge/cloud.ts token    print a current access token, for curl
//
// The bridge is an ordinary OAuth client of the Worker: it registers itself,
// then signs in with PKCE through a one-shot server on a loopback port, the
// way RFC 8252 has native apps do it. What it gets is kept in
// $XDG_STATE_HOME/corkboard/auth.json, readable only by this user, and
// token() refreshes it as it expires.
//
// CORKBOARD_CLOUD: the Worker's origin.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const CLOUD = (process.env.CORKBOARD_CLOUD ?? "https://corkboard.matthewjurenka.workers.dev").replace(/\/$/, "");
const STATE_DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "corkboard");
const AUTH = join(STATE_DIR, "auth.json");

type Auth = { cloud: string; client_id: string; access_token: string; refresh_token: string; expires_at: number };

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
    Bun.spawn(["xdg-open", url.toString()], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
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

// A current access token, refreshed when it's within a minute of expiring.
// Refresh tokens rotate, so each refresh is saved before it's used.
export async function token(): Promise<string> {
  const auth = load();
  if (!auth) throw new Error(`corkboard: not signed in to ${CLOUD}; run bun bridge/cloud.ts login`);
  if (auth.expires_at - 60_000 > Date.now()) return auth.access_token;
  const t = await tokens({ grant_type: "refresh_token", refresh_token: auth.refresh_token, client_id: auth.client_id }).catch((e) => {
    throw new Error(`${e.message}; run bun bridge/cloud.ts login`);
  });
  save({ ...auth, access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 });
  return t.access_token;
}

if (import.meta.main) {
  const command = process.argv[2];
  try {
    if (command === "login") {
      await login();
      process.exit(0); // the paste reader would otherwise hold stdin open
    }
    else if (command === "token") console.log(await token());
    else {
      console.error("usage: bun bridge/cloud.ts login|token");
      process.exit(2);
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
