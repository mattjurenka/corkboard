import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each test signs in and makes Durable Objects afresh, which on a busy
  // machine or CI runner takes longer than vitest's 5 and 10 seconds.
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Workers AI and Vectorize would open a session with Cloudflare, which
      // wants an API token on CI; MEMORY_VECTORS below keeps them unused.
      remoteBindings: false,
      miniflare: {
        bindings: {
          ORIGIN: "https://corkboard.test",
          ADMIN_EMAILS: "me@example.com",
          HOLDS_KEY: "holds-key-for-tests",
          TIMEZONE: "America/Phoenix",
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
          CALENDAR_ID: "claude@group.calendar.google.com",
          FORGEJO_ORIGIN: "https://git.test",
          FORGEJO_TOKEN: "forgejo-token",
          // Workers AI and Vectorize are remote; these tests stay local.
          MEMORY_VECTORS: "off",
        },
        // The portal's Worker (../portal), as a stand-in that says what it was asked.
        workers: [
          {
            name: "corkboard-portal",
            modules: true,
            script: "export default { fetch: (r) => new Response('portal ' + new URL(r.url).pathname) }",
          },
        ],
      },
    }),
  ],
});
