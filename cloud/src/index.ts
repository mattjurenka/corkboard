// The corkboard Worker. The OAuth provider owns the token, registration and
// discovery endpoints; /api/* reaches api.ts only with a valid access token;
// everything else (the sign-in pages) is auth.ts.

import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { api, tokenKey } from "./api";
import { auth } from "./auth";
import type { Board } from "./board";
import type { Grant } from "./mcp";
import type { User } from "./user";

export { Board } from "./board";
export { User } from "./user";

export type Env = {
  BOARD: DurableObjectNamespace<Board>;
  USER: DurableObjectNamespace<User>;
  OAUTH_KV: KVNamespace;
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
};

// What a token carries about its user. Encrypted in KV by the provider. A
// card token (POST /api/tokens) or Pepper's (/api/tokens/pepper) also
// carries its grant.
export type Props = { userId: string; email: string; grant?: Extract<Grant, { kind: "card" | "pepper" }> };

// Card and Pepper tokens start with this, so they're told from OAuth tokens
// at a glance.
export const CARD_TOKEN = "cbc_";

// Built on first request, since the resource's URL comes from env.
let provider: OAuthProvider<Env> | undefined;

function oauth(env: Env): OAuthProvider<Env> {
  provider ??= new OAuthProvider<Env>({
    apiRoute: ["/api/", "/mcp"],
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

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauth(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
