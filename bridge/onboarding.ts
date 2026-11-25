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

// Accepted once its digits are said to match: from then it's on its way to
// being this machine's account, and isn't ended for another.
type Join = { view: JoinView; answer?: (ok: boolean) => void; shown: Promise<void>; ended?: boolean; accepted?: boolean };
let join: Join | undefined;

const store = new Keystore();
const pass = () => process.env.CORKBOARD_E2EE_PASSPHRASE || undefined;

export const hasAccount = () => store.exists();

// The account being made or recovered, until its node is up (ready): one at
// a time, and the page isn't told there's an account before then, or a
// second tab would start Neovim without the node's memory.
let making: Promise<Response> | undefined;
async function alone(make: () => Promise<Response>): Promise<Response> {
  if (making) return json({ error: "an account is being made already" }, 409);
  making = make();
  try {
    return await making;
  } finally {
    making = undefined;
  }
}
const joining = () => !!join && !join.view.account && !join.view.error;
const committed = () => !!join?.accepted && joining();
const settled = () => hasAccount() && !making && !joining();

// The node started, its failure logged rather than hiding the account made,
// and started again when the page next asks (GET /account).
let down = false;
const start = (ready: () => Promise<void>) =>
  ready().then(
    () => void (down = false),
    (e) => {
      down = true;
      console.error(`node: ${(e as Error).message}`);
    },
  );

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
      await start(ready);
      j.view = { account };
    })
    .catch((e) => (j.view = { error: (e as Error).message }))
    .finally(() => {
      j.answer = undefined;
      shown();
    });
  return j;
}

// False for a join that's committed, which goes on.
function endJoin() {
  if (committed()) return false;
  if (join) join.ended = true;
  join?.answer?.(false);
  join = undefined;
  return true;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

// The page's calls, already let in (server.ts checks its origin and token).
export async function account(req: Request, path: string, ready: () => Promise<void>): Promise<Response> {
  if (path === "/account" && req.method === "GET") {
    if (down && settled()) await start(ready);
    return json({ account: settled(), join: join?.view ?? null });
  }
  if (req.method !== "POST") return json({ error: "POST" }, 405);
  const body = (await req.json().catch(() => ({}))) as { phrase?: unknown; ok?: unknown };
  if (committed() && path !== "/account/join" && path !== "/account/join/confirm") return json({ error: "an account is being joined already" }, 409);
  try {
    switch (path) {
      case "/account/create":
        return await alone(async () => {
          endJoin();
          const { root, account } = await localAccount(hostname(), pass());
          await start(ready);
          return json({ account, phrase: toPhrase(root) });
        });
      case "/account/recover": {
        const phrase = body.phrase;
        if (typeof phrase !== "string") return json({ error: "phrase" }, 400);
        return await alone(async () => {
          endJoin();
          const account = await recoverAccount(phrase, hostname(), pass());
          await start(ready);
          return json({ account });
        });
      }
      case "/account/join": {
        if (making) return json({ error: "an account is being made already" }, 409);
        if (hasAccount() && !joining()) return json({ error: "this machine is already in an account" }, 409);
        if (!join || join.view.error) join = startJoin(ready);
        await join.shown;
        return json({ join: join.view });
      }
      case "/account/join/confirm": {
        if (!join?.answer) return json({ error: "nothing to confirm" }, 409);
        join.accepted = body.ok === true;
        join.answer(join.accepted);
        join.answer = undefined;
        // Answered: the code again, waiting, until joinAccount says how it went.
        const { sas: _, ...waiting } = join.view;
        join.view = waiting;
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
