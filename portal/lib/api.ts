// The portal is an OAuth client of the API Worker on this same origin like
// any other (cloud/src/index.ts): it registers itself, signs in with PKCE,
// and keeps its tokens in localStorage, under the key the hand-written portal
// used, so a sign-in carries over. Coming back from signing in lands on "/",
// which sends the user on to where they were.

const KEY = "corkboard.portal"

type Auth = {
  client_id?: string
  access_token?: string
  refresh_token?: string
  expires_at?: number
  signed_out?: boolean
}

const redirect = () => location.origin + "/"

function load(): Auth {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}
  } catch {
    return {}
  }
}

function save(a: Auth) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a))
  } catch {}
}

let auth: Auth | undefined
const current = () => (auth ??= load())

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

export const signedOut = () => !!current().signed_out

export async function signIn(): Promise<never> {
  let a = current()
  if (!a.client_id) {
    const reg = await fetch("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "corkboard portal",
        redirect_uris: [redirect()],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    })
    if (reg.status !== 201) throw new Error("couldn't register: " + (await reg.text()))
    a = auth = { client_id: (await reg.json()).client_id }
    save(a)
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)))
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)))
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))))
  sessionStorage.setItem(KEY, JSON.stringify({ verifier, state, back: location.pathname + location.search }))
  const q = new URLSearchParams({
    response_type: "code",
    client_id: a.client_id!,
    redirect_uri: redirect(),
    scope: "owner",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  location.assign("/authorize?" + q)
  return new Promise<never>(() => {})
}

async function tokens(params: Record<string, string>): Promise<boolean> {
  const a = current()
  const res = await fetch("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: a.client_id!, ...params }),
  })
  if (!res.ok) return false
  const t = await res.json()
  auth = { ...a, access_token: t.access_token, refresh_token: t.refresh_token ?? a.refresh_token, expires_at: Date.now() + t.expires_in * 1000 }
  delete auth.signed_out
  save(auth)
  return true
}

// One refresh or sign-in at a time: a view asks for several things at once,
// and each would otherwise sign in on its own, leaving the state of only the
// last to answer to.
let pending: Promise<string> | null = null

async function token(stale: boolean): Promise<string> {
  const a = current()
  if (a.access_token && !stale && (a.expires_at ?? 0) > Date.now() + 60_000) return a.access_token
  pending ??= (async () => {
    if (a.refresh_token && (await tokens({ grant_type: "refresh_token", refresh_token: a.refresh_token }))) return current().access_token!
    return signIn()
  })().finally(() => (pending = null))
  return pending
}

// Back from signing in: the path to go on to (which also drops the code from
// the address), or null if this wasn't that.
export async function answered(): Promise<string | null> {
  const q = new URLSearchParams(location.search)
  if (!q.has("code") && !q.has("error")) return null
  const asked = JSON.parse(sessionStorage.getItem(KEY) ?? "{}")
  sessionStorage.removeItem(KEY)
  if (q.get("error")) throw new Error("sign-in: " + q.get("error"))
  if (q.get("state") !== asked.state) throw new Error("sign-in answered for another request")
  if (!(await tokens({ grant_type: "authorization_code", code: q.get("code")!, redirect_uri: redirect(), code_verifier: asked.verifier })))
    throw new Error("sign-in failed")
  return asked.back && asked.back !== "/" ? asked.back : "/"
}

// Revoking the refresh token ends the grant, and the access token with it.
export async function signOut() {
  const a = current()
  if (a.refresh_token) {
    await fetch("/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: a.client_id!, token: a.refresh_token, token_type_hint: "refresh_token" }),
    }).catch(() => {})
  }
  auth = { client_id: a.client_id, signed_out: true }
  save(auth)
}

export function allowSignIn() {
  auth = { client_id: current().client_id }
  save(auth)
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  for (const stale of [false, true]) {
    const res = await fetch(path, {
      method,
      headers: { Authorization: "Bearer " + (await token(stale)), ...(body !== undefined && { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 401 && !stale) continue
    const json = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(json.error ?? "HTTP " + res.status)
    return json as T
  }
  throw new Error("signed out")
}

// What the API answers with, as far as the portal reads it.
export type Board = { key: string; name: string; root: string | null; remotes?: string[]; environments?: string[] }
export type Bridge = { id: string; machine: string; url: string | null; environment: string | null }
export type Repo = { owner: string; name: string; private: boolean; default_branch: string; updated: string; empty: boolean; url: string }
export type RepoInfo = Repo & { branches: string[] }
export type Entry = { name: string; path: string; type: "file" | "dir" | "symlink" | "submodule"; size: number }
export type Dir = { type: "dir"; path: string; entries: Entry[] }
export type File = { type: "file"; name: string; path: string; size: number; url: string; content: string | null; binary: boolean; too_large: boolean }
export type Branch = {
  name: string
  sha: string
  message: string
  author: string | null
  date: string | null
  default: boolean
  ahead: number | null
  behind: number | null
}
