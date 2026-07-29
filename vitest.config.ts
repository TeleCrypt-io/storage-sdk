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
    exclude: ["**/node_modules/**", "ui/**"],
  },
});
