import { defineConfig } from "vitest/config";

// PRODUCTION functional suite (Part A of docs/PROD_TESTING_SPEC.md) — hits
// REAL telecrypt.io via redpill-provisioned throwaway accounts. Deliberately
// a SEPARATE config from vitest.config.ts (root `npm test`):
//   - no `globalSetup` (that config's globalSetup requires a local Synapse
//     on localhost:8008, which must never be a prerequisite for hitting
//     prod, and isn't up in this workflow anyway),
//   - `include` restricted to test/production/*.test.ts only, so it never
//     picks up test/production/deployed-ui.spec.ts (that's Playwright's
//     job, see playwright.prod.config.ts) or anything under test/functional.
// Only ever invoked explicitly via `npm run test:prod` — never part of the
// default `npm test` glob (vitest.config.ts excludes test/production/**
// entirely, so there is no overlap even if someone ran plain `vitest run`
// with this file present).
export default defineConfig({
  test: {
    include: ["test/production/**/*.test.ts"],
    testTimeout: 60000,
    hookTimeout: 60000,
    // Real prod network + real S3-backed media, and redpill is rate-limited
    // (5/min per source IP) — provisioning must stay serial, never
    // cross-file-parallel. All redpill calls live in one file's beforeAll
    // (storage.test.ts); this is belt-and-suspenders in case a second
    // *.test.ts file is ever added here without revisiting that rule.
    fileParallelism: false,
  },
});
