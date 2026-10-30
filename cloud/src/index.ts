// The corkboard Worker. The OAuth provider owns the token, registration and
// discovery endpoints; /api/*, /mcp and /memory/* reach api.ts only with a
// valid access token; everything else (the sign-in pages, and the portal's
// page by way of them) is auth.ts.

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { api, tokenKey } from "./api";
import { auth } from "./auth";
import type { Board } from "./board";
import { upload } from "./media";
import type { Grant } from "./mcp";
import type { Memory } from "./memory";
import type { User } from "./user";

export { Board } from "./board";
export { Memory } from "./memory";
export { User } from "./user";

export type Env = {
  BOARD: DurableObjectNamespace<Board>;
  USER: DurableObjectNamespace<User>;
  MEMORY: DurableObjectNamespace<Memory>;
  // Recall by meaning (src/vectors.ts): embeddings, and the index they're
  // kept in. MEMORY_VECTORS "off" does without both (the tests).
  AI: Ai;
  VECTORS: VectorizeIndex;
  MEMORY_VECTORS?: string;
  OAUTH_KV: KVNamespace;
  // Files attached to cards (media.ts).
  MEDIA: R2Bucket;
  OAUTH_PROVIDER: OAuthHelpers;
  // The Worker's own origin, no trailing slash: the token audience and
  // Google's redirect URI are built from it.
  ORIGIN: string;
  // The one Google account allowed in.
  ALLOWED_EMAIL: string;
  // Where "today" is, for plans (IANA, America/Phoenix).
  TIMEZONE: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  // Forgejo, whose repositories the portal browses (git.ts), and a read-only
  // token of the user's there (a secret); without them, none.
  FORGEJO_ORIGIN?: string;
  FORGEJO_TOKEN?: string;
  // The portal's page (../portal), which serves every path that isn't ours.
  PORTAL?: Fetcher;
};

// What a token carries about its user. Encrypted in KV by the provider. A
// card token (POST /api/tokens) or Pepper's (/api/tokens/pepper) also
// carries its grant, as does a machine's (/api/tokens/machine).
export type Props = { userId: string; email: string; grant?: Extract<Grant, { kind: "card" | "pepper" | "brain" | "machine" }> };

// Card and Pepper tokens start with this, so they're told from OAuth tokens
// at a glance.
export const CARD_TOKEN = "cbc_";

// Built on first request, since the resource's URL comes from env.
let provider: OAuthProvider<Env> | undefined;

function oauth(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: ["/api/", "/mcp", "/memory/"],
    // The provider passes OAuthResourceContext, which its handler type
    // declares as a plain ExecutionContext.
    apiHandler: api as unknown as Required<Pick<ExportedHandler<Env>, "fetch">>,
    defaultHandler: auth as ExportedHandler<Env>,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    // The phone app (android/) comes back from the browser to its own
    // scheme, app.corkboard:/oauth (RFC 8252's private-use URIs): Android
    // freezes an app in the background, so a loopback port like the
    // bridge's goes unanswered. PKCE keeps the code to the app that asked.
    allowPrivateUseRedirectUris: true,
    scopesSupported: ["owner", "assistant"],
    // What an MCP client should ask for first (the bridge asks for owner).
    requiredScopes: ["assistant"],
    resourceMetadata: { resource: env.ORIGIN, authorization_servers: [env.ORIGIN] },
    // A grant lives while it's used: the bridge refreshes daily, so it stays
    // signed in, and a forgotten client lapses after 30 idle days.
    refreshTokenIdleTTL: 30 * 24 * 3600,
    // Card tokens are ours too, just not OAuth's: looked up by hash.
    resolveExternalToken: async ({ token, env }) => {
      if (!token.startsWith(CARD_TOKEN)) return null;
      const props = await env.OAUTH_KV.get<Props>(await tokenKey(token), "json");
      return props ? { props, audience: env.ORIGIN } : null;
    },
  });
  return provider;
}

// A browser's WebSocket can't carry an Authorization header, so a page
// (web/src/cloud.ts) sends its token as a subprotocol beside "corkboard":
// corkboard.bearer.<the token, base64url>. It becomes the header, and the
// socket answers with "corkboard", which the browser wants named back.
const BEARER = "corkboard.bearer.";
function bearerOf(request: Request): string | undefined {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket" || request.headers.has("Authorization")) return;
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
  const b64 = offered.find((p) => p.startsWith(BEARER))?.slice(BEARER.length);
  if (!b64 || !offered.includes("corkboard")) return;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  } catch {
    return;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // An upload's URL is its own auth (media.ts), for an agent's curl.
    if (new URL(request.url).pathname.startsWith("/upload/")) return upload(request, env);
    const bearer = bearerOf(request);
    if (!bearer) return oauth(env).fetch(request, env, ctx);
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${bearer}`);
    headers.delete("Sec-WebSocket-Protocol");
    const res = await oauth(env).fetch(new Request(request, { headers }), env, ctx);
    if (res.status !== 101) return res;
    return new Response(null, { status: 101, webSocket: res.webSocket, headers: { "Sec-WebSocket-Protocol": "corkboard" } });
  },
} satisfies ExportedHandler<Env>;
