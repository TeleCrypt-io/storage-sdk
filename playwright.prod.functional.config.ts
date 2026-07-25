import { defineConfig, devices } from "@playwright/test";

// Deployed-UI functional (Part C of docs/PROD_TESTING_SPEC.md) — full OIDC
// login + connect + file-manager ops against LIVE https://storage.telecrypt.io.
// Requires PROD_TEST_USER_1/PASS_1. Separate from playwright.prod.config.ts
// (Part B smoke), which stays credential-free.
export default defineConfig({
  testDir: "./test/production",
  testMatch: "deployed-ui-functional.spec.ts",
  timeout: 180_000,
  expect: { timeout: 30_000 },
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
