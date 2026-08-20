import { defineConfig } from "vitest/config";

// Unit-only test-harness checks: no Podman/Synapse global setup.
export default defineConfig({
  test: {
    include: [
      "test/oidcApproval.test.ts",
      "test/oidc-refresh.test.ts",
      "test/recovery-callback.test.ts",
    ],
  },
});
