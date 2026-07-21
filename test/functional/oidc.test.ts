// Node has no native IndexedDB, so we polyfill it for this file only
// (vitest isolates each test file's globals) — needed because
// TeleCryptIOStorage.createFromOidc() below sets up a real persistent crypto
// store, same as every other functional test file. See core.test.ts/
// keys.test.ts for the same pattern.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { registerAndWaitForMasProvisioning } from "../harness/users";
import { approveDeviceCodeViaHttp } from "../harness/oidcApproval";
import { waitFor } from "../harness/waitFor";
import { withOidcWindowShim } from "../../src/cli/oidcWindowPolyfill.js";
import * as oidc from "../../src/core/oidc.js";
import * as core from "../../src/core/operations.js";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";

const HOMESERVER = "http://localhost:8008";

function randomLocalpart(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

async function registerOidcTestUser(prefix: string): Promise<{ localpart: string; password: string }> {
  const localpart = randomLocalpart(prefix);
  const password = "pw_" + Math.random().toString(36).slice(2, 10);
  // MAS provisions the Synapse-side account asynchronously — see
  // test/harness/users.ts's doc comment. Waiting here means the device-code
  // flow below (which needs Synapse to know about this account by the time
  // it exchanges the device code for a token) never races it.
  await registerAndWaitForMasProvisioning(localpart, password);
  return { localpart, password };
}

/**
 * Runs the full device-code grant end to end against the local MAS
 * (throwaway_synapse/up.sh, docs/DECISIONS.md D6): discovery, dynamic client
 * registration, start device authorization, approve it exactly as a human
 * would (login + enter code + consent — driven headlessly over HTTP by
 * `approveDeviceCodeViaHttp`, since this test controls the dev MAS and the
 * test account's real password), then poll for the resulting token set.
 */
async function runDeviceCodeLogin(
  deviceId: string,
  user: { localpart: string; password: string },
): Promise<{ authMetadata: oidc.OidcClientConfig; clientId: string; result: oidc.DeviceAccessTokenResponse }> {
  // Discovery is the one OIDC call that needs a `window` shim under Node —
  // see src/cli/oidcWindowPolyfill.ts. Scoped narrowly, same as the CLI.
  const authMetadata = await withOidcWindowShim(() => oidc.discoverOidcIssuer(HOMESERVER));
  expect(authMetadata.device_authorization_endpoint).toBeTruthy();

  const clientId = await oidc.registerClient(authMetadata, {
    clientName: "TeleCrypt.io functional test",
    clientUri: "http://localhost:1234/",
    applicationType: "native",
    redirectUris: ["http://localhost:1234/callback"],
    contacts: undefined,
    tosUri: undefined,
    policyUri: undefined,
  });

  const session = await oidc.startDeviceCodeLogin(authMetadata, clientId, deviceId);
  expect(session.user_code).toBeTruthy();
  expect(session.verification_uri).toBeTruthy();

  const [result] = await Promise.all([
    oidc.waitForDeviceCodeLogin(authMetadata, clientId, session),
    approveDeviceCodeViaHttp(user.localpart, user.password, session.user_code),
  ]);

  if (oidc.isDeviceAccessTokenError(result)) {
    throw new Error(`device code login was rejected: ${result.error_description ?? result.error}`);
  }
  return { authMetadata, clientId, result };
}

describe("OIDC/MAS login", () => {
  it(
    "O.1 device-code grant end-to-end yields a working token and a usable TeleCryptIOStorage",
    async () => {
      const user = await registerOidcTestUser("oidc_device");
      const deviceId = "OIDCDEVTEST1";

      const { result } = await runDeviceCodeLogin(deviceId, user);
      expect(result.access_token).toBeTruthy();
      expect(result.refresh_token).toBeTruthy();

      const who = await oidc.whoAmI(HOMESERVER, result.access_token);
      expect(who.userId).toBe(`@${user.localpart}:localhost`);
      expect(who.deviceId).toBe(deviceId);

      const storage = await TeleCryptIOStorage.createFromOidc({
        baseUrl: HOMESERVER,
        userId: who.userId,
        accessToken: result.access_token,
        deviceId,
      });
      try {
        // The mandatory proof this is a genuinely usable storage instance,
        // not just "a token that whoami accepts" — mirrors what the
        // password-login smoke test proves for m.login.password. A newly
        // created room can take a beat to settle as "top-level" in this
        // same client's own sync state — same real async-settling window
        // core.test.ts's C.1 already polls for, not a fixed sleep.
        const folder = await core.createFolder(storage, "OidcDeviceCodeFolder");
        expect(folder.id).toBeTruthy();
        await waitFor(
          async () => {
            const all = await core.listFolders(storage);
            return all.some((f) => f.id === folder.id) || null;
          },
          { label: "folder appears in listFolders" },
        );
      } finally {
        storage.getClient().stopClient();
      }
    },
    45000,
  );

  it(
    "O.2 token refresh yields a new, independently working access token",
    async () => {
      const user = await registerOidcTestUser("oidc_refresh");
      const deviceId = "OIDCREFRTEST1";

      const { authMetadata, clientId, result } = await runDeviceCodeLogin(deviceId, user);
      expect(result.refresh_token).toBeTruthy();

      // Deliberately NOT matrix-js-sdk's OidcTokenRefresher — see
      // src/cli/oidcWindowPolyfill.ts's doc comment for why
      // `refreshOidcToken` (plain fetch, no `window` dependency at all) is
      // used instead. Assert directly on the raw refresh, then again via
      // `buildTokenRefreshFunction`'s wiring (persistence hook) below.
      const refreshed = await oidc.refreshOidcToken(authMetadata.token_endpoint, clientId, result.refresh_token!);
      expect(refreshed.accessToken).toBeTruthy();
      expect(refreshed.accessToken).not.toBe(result.access_token);

      // Prove the REFRESHED token is genuinely independently usable — not
      // just "the endpoint returned a string" — by driving a real storage
      // operation with it, same bar as O.1.
      const who = await oidc.whoAmI(HOMESERVER, refreshed.accessToken);
      expect(who.userId).toBe(`@${user.localpart}:localhost`);

      // Also exercise `buildTokenRefreshFunction`'s persistence-hook wiring
      // directly — this is the exact function src/cli/storage.ts and
      // ui/src/context/StorageContext.tsx wire into `createFromOidc`'s
      // `tokenRefreshFunction`, so this is what actually runs when
      // matrix-js-sdk triggers an automatic refresh mid-request.
      let persisted: { accessToken: string; refreshToken?: string } | null = null;
      const tokenRefreshFunction = oidc.buildTokenRefreshFunction(
        authMetadata.token_endpoint,
        clientId,
        async (tokens) => {
          persisted = tokens;
        },
      );
      const secondRefresh = await tokenRefreshFunction(refreshed.refreshToken!);
      expect(secondRefresh.accessToken).toBeTruthy();
      expect(secondRefresh.accessToken).not.toBe(refreshed.accessToken);
      expect(persisted).not.toBeNull();
      expect(persisted!.accessToken).toBe(secondRefresh.accessToken);

      const storage = await TeleCryptIOStorage.createFromOidc({
        baseUrl: HOMESERVER,
        userId: who.userId,
        accessToken: refreshed.accessToken,
        deviceId,
      });
      try {
        const folder = await core.createFolder(storage, "OidcRefreshedTokenFolder");
        expect(folder.id).toBeTruthy();
      } finally {
        storage.getClient().stopClient();
      }
    },
    45000,
  );
});
