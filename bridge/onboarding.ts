// The first start's question, asked by the page (web/src/components/Welcome.tsx)
// before it starts Neovim: this machine's account made new here, joined from
// a device already in one (pairNew, approved from that device's Pair a
// device), or recovered from its phrase. Until one of them, the bridge has
// no account and so no node (server.ts); ready starts it.
//
//   GET  /account               { account, join }
//   POST /account/create        { account, phrase }: the phrase is shown once
//   POST /account/recover       { phrase } -> { account }
//   POST /account/join          { join }, once its code is there
//   POST /account/join/confirm  { ok }: the six digits match, or don't
//   POST /account/join/cancel

import { hostname } from "node:os";
import { joinAccount, localAccount, recoverAccount } from "./e2ee";
import { Keystore } from "./keystore";
import { toPhrase } from "../lib/e2ee/phrase";
import { showCode } from "../lib/e2ee/wire";

// What the page shows of a join: its code to type on the other device,
// then the six digits to check, then the account or why not.
export type JoinView = { code?: string; qr?: string; sas?: string; account?: string; error?: string };

type Join = { view: JoinView; answer?: (ok: boolean) => void; shown: Promise<void>; ended?: boolean };
let join: Join | undefined;

const store = new Keystore();
const pass = () => process.env.CORKBOARD_E2EE_PASSPHRASE || undefined;

export const hasAccount = () => store.exists();

function startJoin(ready: () => Promise<void>): Join {
  let shown!: () => void;
  const j: Join = { view: {}, shown: new Promise((r) => (shown = r)) };
  const ui = {
    show: (code: string, qr: string) => {
      j.view = { code: showCode(code), qr };
      shown();
    },
    confirm: (sas: string) =>
      new Promise<boolean>((resolve) => {
        if (j.ended) return resolve(false);
        j.view = { ...j.view, sas };
        j.answer = resolve;
      }),
  };
  joinAccount(ui, hostname(), pass())
    .then(async (account) => {
      await ready();
      j.view = { account };
    })
    .catch((e) => (j.view = { error: (e as Error).message }))
    .finally(() => {
      j.answer = undefined;
      shown();
    });
  return j;
}

function endJoin() {
  if (join) join.ended = true;
  join?.answer?.(false);
  join = undefined;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// The page's calls, already let in (server.ts checks its origin and token).
export async function account(req: Request, path: string, ready: () => Promise<void>): Promise<Response> {
  if (path === "/account" && req.method === "GET") return json({ account: hasAccount(), join: join?.view ?? null });
  if (req.method !== "POST") return json({ error: "POST" }, 405);
  const body = (await req.json().catch(() => ({}))) as { phrase?: unknown; ok?: unknown };
  try {
    switch (path) {
      case "/account/create": {
        endJoin();
        const { root, account } = await localAccount(hostname(), pass());
        await ready();
        return json({ account, phrase: toPhrase(root) });
      }
      case "/account/recover": {
        if (typeof body.phrase !== "string") return json({ error: "phrase" }, 400);
        endJoin();
        const account = await recoverAccount(body.phrase, hostname(), pass());
        await ready();
        return json({ account });
      }
      case "/account/join": {
        if (hasAccount()) return json({ error: "this machine is already in an account" }, 409);
        if (!join || join.view.error) join = startJoin(ready);
        await join.shown;
        return json({ join: join.view });
      }
      case "/account/join/confirm": {
        if (!join?.answer) return json({ error: "nothing to confirm" }, 409);
        join.answer(body.ok === true);
        join.answer = undefined;
        return json({ join: join.view });
      }
      case "/account/join/cancel":
        endJoin();
        return json({ join: null });
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
  return json({ error: "not found" }, 404);
}
