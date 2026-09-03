import { defineConfig } from "vitest/config";

// Unit-only test-harness checks: no Podman/Synapse global setup.
export default defineConfig({
  test: {
    include: [
      "test/oidcApproval.test.ts",
      "test/oidc-refresh.test.ts",
      "test/oidc-deviceid.test.ts",
      "test/pending-invites.test.ts",
      "test/bootstrap-recovery.test.ts",
      "test/tree-mutations.test.ts",
      "test/operations-safety.test.ts",
      "test/projection-race.test.ts",
      "test/cross-client-delete.test.ts",
      "test/media-safety.test.ts",
      "test/users.test.ts",
      "test/npm-provenance.test.ts",
    ],
  },
});
