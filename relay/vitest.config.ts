import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Each test makes Durable Objects afresh, which on a busy machine or CI
  // runner takes longer than vitest's 5 and 10 seconds.
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ORIGIN: "https://relay.test",
          RELAY_INVITE: "invite-for-tests",
        },
      },
    }),
  ],
});
