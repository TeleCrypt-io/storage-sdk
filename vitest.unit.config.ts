import { defineConfig } from "vitest/config";

// Leave the shared-stack tests to `npm test`; unit mode needs no services.
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "test/functional/**", "test/device-reuse.test.ts"],
  },
});
