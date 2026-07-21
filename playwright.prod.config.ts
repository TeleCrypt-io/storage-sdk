import { defineConfig, devices } from "@playwright/test";

// Deployed-UI smoke (Part B of docs/PROD_TESTING_SPEC.md) — drives a real
// browser against the LIVE https://storage.telecrypt.io. Deliberately
// separate from ui/playwright.config.ts, which starts a local Vite dev
// server + disposable Synapse via `webServer`: this config has NO
// `webServer` at all — it only ever talks to the real deployed site, never
// local infra. `testMatch` is scoped to the one prod spec so this config
// can never accidentally pick up vitest's *.test.ts files in the same
// directory.
export default defineConfig({
  testDir: "./test/production",
  testMatch: "deployed-ui.spec.ts",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "https://storage.telecrypt.io",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
