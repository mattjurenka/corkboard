import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ORIGIN: "https://corkboard.test",
          ALLOWED_EMAIL: "me@example.com",
          TIMEZONE: "America/Phoenix",
          GOOGLE_CLIENT_ID: "google-client",
          GOOGLE_CLIENT_SECRET: "google-secret",
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
