// Talking to the forge gate (forge/gate) from a device or a grant's holder:
// opening a session, and sending it the account's rotations and revocations.

import { type Chain, type ForgeGrant, type GrantRevocation, type Scope, type Signer, answerForge } from "./forge";
import type { AccountView, Revocation, Signed } from "./wire";

export type ForgeSession = { token: string; expires: number; user: string; scope: Scope | null };

async function call<T>(gate: string, path: string, init?: RequestInit, f: typeof fetch = fetch): Promise<T> {
  const res = await f(new URL(path, gate), { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  const out = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(`forge gate ${path}: ${out.error ?? res.status}`);
  return out;
}

// gate: the gate's origin (https://git.corkboard.fyi). holder answers the
// gate's nonce: the cert's device with no grants, else the last grant's holder.
export async function openForgeSession(gate: string, account: string, holder: Signer, chain: Chain, f?: typeof fetch): Promise<ForgeSession> {
  const { nonce, origin } = await call<{ nonce: string; origin: string }>(gate, "/gate/challenge", undefined, f);
  const answer = answerForge(holder, origin, nonce);
  return call<ForgeSession>(gate, "/gate/session", { method: "POST", body: JSON.stringify({ account, chain, answer }) }, f);
}

// The account's key moved on (a rotation).
export const sendViewToGate = (gate: string, view: AccountView, f?: typeof fetch) => call<{ account: string; key: string }>(gate, "/gate/account", { method: "POST", body: JSON.stringify({ view }) }, f);

// A device taken back, or a grant. A gate that hasn't this account bound
// answers 404, which isn't an error here.
export async function sendRevocationToGate(gate: string, account: string, r: { revocation?: Signed<Revocation>; grant?: Signed<GrantRevocation> }, f?: typeof fetch) {
  try {
    await call(gate, "/gate/revoke", { method: "POST", body: JSON.stringify({ account, ...r }) }, f);
  } catch (e) {
    if (!String(e).includes("no such account")) throw e;
  }
}

export type { Chain, ForgeGrant };
