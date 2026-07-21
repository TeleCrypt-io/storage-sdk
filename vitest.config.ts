import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/harness/globalSetup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // ui/ is its own Vite app with its own vitest config (jsdom, mocked
    // core/) — exclude it here so the root suite stays exactly the 51
    // library/CLI tests and doesn't double-run (or environment-clash with)
    // the UI's wiring tests.
    //
    // test/production/** hits REAL telecrypt.io (redpill-provisioned
    // throwaway accounts) and must NEVER run as part of a normal local/CI
    // `npm test`. Excluded here (directory-based guard) in addition to only
    // being reachable via the separate vitest.prod.config.ts + `npm run
    // test:prod` — see docs/PROD_TESTING_SPEC.md.
    exclude: ["**/node_modules/**", "ui/**", "test/production/**"],
  },
});
