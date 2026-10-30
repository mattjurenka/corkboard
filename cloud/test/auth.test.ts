import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consent, google, login, worker } from "./login";

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe("sign-in", () => {
  it("shows the client's name, where access goes, and a loopback warning", async () => {
    const { res, html, handle } = await consent();
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(html).toContain("corkboard bridge");
    expect(html).toContain("127.0.0.1");
    expect(html).toContain("an app on this computer");
    expect(handle).toBeTruthy();
  });

  it("signs in the phone app through its own URL scheme", async () => {
    const { html } = await consent("owner", "app.corkboard:/oauth");
    expect(html).toContain("app.corkboard:/oauth");
    expect(html).not.toContain("an app on this computer");
    google("me@example.com");
    const { redirect, tokens } = await login({ redirect: "app.corkboard:/oauth" });
    expect(redirect!.protocol).toBe("app.corkboard:");
    expect(tokens!.access_token).toBeTruthy();
  });

  it("goes to Google with PKCE and the allowed account as a hint", async () => {
    google("me@example.com");
    const { toGoogle } = await login();
    expect(toGoogle!.searchParams.get("redirect_uri")).toBe("https://corkboard.test/callback");
    expect(toGoogle!.searchParams.get("code_challenge_method")).toBe("S256");
    expect(toGoogle!.searchParams.get("login_hint")).toBe("me@example.com");
    expect(toGoogle!.searchParams.get("scope")).toBe("openid email");
  });

  it("issues owner tokens to the allowed account", async () => {
    google("Me@Example.com");
    const { redirect, tokens } = await login();
    expect(redirect!.searchParams.get("state")).toBe("client-state");
    expect(tokens!.access_token).toBeTruthy();
    expect(tokens!.refresh_token).toBeTruthy();
    expect(tokens!.scope).toBe("owner");
  });

  it("refuses any other Google account", async () => {
    google("someone@else.com");
    const { redirect, tokens } = await login();
    expect(tokens).toBeUndefined();
    expect(redirect!.searchParams.get("error")).toBe("access_denied");
  });

  it("refuses an unverified email or a token for another app", async () => {
    google("me@example.com", "s", { email_verified: false });
    expect((await login()).status).toBe(502);
    google("me@example.com", "s", { aud: "someone-else" });
    expect((await login()).status).toBe(502);
  });

  it("sends Deny back to the client as access_denied, without Google", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { redirect } = await login({ decision: "deny" });
    expect(redirect!.origin).toBe("http://127.0.0.1:9999");
    expect(redirect!.searchParams.get("error")).toBe("access_denied");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a consent post from a browser that didn't open the page", async () => {
    const { handle } = await consent();
    const res = await worker("/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: handle!, decision: "approve", scope: "owner" }),
      redirect: "manual",
    });
    expect(res.status).toBe(400);
  });

  it("refreshes, rotating the refresh token", async () => {
    google("me@example.com");
    const { tokens, clientId } = await login();
    const refresh = (token: string) =>
      worker("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: token, client_id: clientId! }),
      });
    const res = await refresh(tokens!.refresh_token);
    expect(res.status).toBe(200);
    const next = await res.json<{ access_token: string; refresh_token: string }>();
    expect(next.refresh_token).not.toBe(tokens!.refresh_token);
    const api = await worker("/api/boards", { headers: { Authorization: `Bearer ${next.access_token}` } });
    expect(api.status).toBe(200);
  });
});

describe("the API", () => {
  it("challenges a request without a token", async () => {
    const res = await worker("/api/boards");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("needs the owner scope", async () => {
    google("me@example.com");
    const { tokens } = await login({ approve: [] });
    expect(tokens!.access_token).toBeTruthy();
    const res = await worker("/api/boards", { headers: { Authorization: `Bearer ${tokens!.access_token}` } });
    expect(res.status).toBe(403);
  });
});

describe("the portal", () => {
  it("is every path that isn't the API's or sign-in's", async () => {
    for (const path of ["/", "/files/mattjurenka/corkboard", "/_next/static/x.js"]) expect(await (await worker(path)).text()).toBe(`portal ${path}`);
    expect((await worker("/api/boards")).status).toBe(401);
    expect(await (await worker("/authorize")).text()).not.toMatch(/^portal/);
    expect(await (await worker("/.well-known/oauth-authorization-server")).json()).toHaveProperty("token_endpoint");
  });
});
