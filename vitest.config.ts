import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PEBBLE_AUTH_TOKEN: "test-pebble-token",
          HERMES_URL: "https://hermes.test/webhooks/pebble",
          HERMES_WEBHOOK_SECRET: "test-hermes-secret",
        },
      },
    }),
  ],
});
