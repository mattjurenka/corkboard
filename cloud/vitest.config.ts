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
          // Workers AI and Vectorize are remote; these tests stay local.
          MEMORY_VECTORS: "off",
        },
      },
    }),
  ],
});
