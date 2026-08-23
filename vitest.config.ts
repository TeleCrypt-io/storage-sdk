import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/harness/globalSetup.ts"],
    // The functional files share one disposable Matrix/MAS/Postgres stack.
    // Running them in parallel makes independent tests contend for the same
    // service resources and turns otherwise healthy cases into timeouts.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: ["**/node_modules/**"],
  },
});
