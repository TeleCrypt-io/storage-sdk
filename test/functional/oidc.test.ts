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
 * Runs the full device-code grant end to end against the local MAS:
 * discovery, dynamic client
 * registration, start device authorization, approve it exactly as a human
 * would (login + enter code + consent — driven headlessly over HTTP by
 * `approveDeviceCodeViaHttp`, since this test controls the dev MAS and the
 * test account's real password), then poll for the resulting token set.
 */
async function runDeviceCodeLogin(
  deviceId: string,
  user: { localpart: string; password: string },
): Promise<{ authMetadata: oidc.OidcClientConfig; clientId: string; result: oidc.DeviceAccessTokenResponse }> {
  // Matrix 42 discovery is a plain metadata fetch and works under Node.
  const authMetadata = await oidc.discoverOidcIssuer(HOMESERVER);
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

      const who = await oidc.whoAmI(HOMESERVER, result.access_token, "localhost:8008");
      expect(who.userId).toBe(`@${user.localpart}:localhost:8008`);
      expect(who.deviceId).toBe(deviceId);

      const storage = await TeleCryptIOStorage.createFromOidc({
        baseUrl: HOMESERVER,
        serverName: "localhost:8008",
        userId: who.userId,
        accessToken: result.access_token,
        deviceId,
      });
      try {
        // The mandatory proof this is a genuinely usable storage instance,
        // not just "a token that whoami accepts". A newly created room can
        // take a beat to settle as "top-level" in this same client's own
        // sync state — the same real async-settling window core.test.ts's
        // C.1 already polls for, not a fixed sleep.
        const vault = await core.createVault(storage, "OidcDeviceCodeVault");
        expect(vault.id).toBeTruthy();
        await waitFor(
          async () => {
            const all = await core.listVaults(storage);
            return all.some((f) => f.id === vault.id) || null;
          },
          { label: "vault appears in listVaults" },
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

      // Use the shared validated refresh path so the CLI and browser adapters
      // persist the same token shape. Assert directly on the raw refresh, then
      // again via `buildTokenRefreshFunction`'s persistence-hook wiring below.
      const refreshed = await oidc.buildTokenRefreshFunction(
        authMetadata,
        clientId,
        async () => {},
        deviceId,
      )(result.refresh_token!);
      expect(refreshed.accessToken).toBeTruthy();
      expect(refreshed.accessToken).not.toBe(result.access_token);

      // Prove the REFRESHED token is genuinely independently usable — not
      // just "the endpoint returned a string" — by driving a real storage
      // operation with it, same bar as O.1.
      const who = await oidc.whoAmI(HOMESERVER, refreshed.accessToken, "localhost:8008");
      expect(who.userId).toBe(`@${user.localpart}:localhost:8008`);

      // Also exercise `buildTokenRefreshFunction`'s persistence-hook wiring
      // directly — callers wire this into `createFromOidc`'s
      // `tokenRefreshFunction`, which matrix-js-sdk invokes when refreshing
      // a token mid-request.
      let persisted: { accessToken: string; refreshToken?: string } | null = null;
      const tokenRefreshFunction = oidc.buildTokenRefreshFunction(
        authMetadata,
        clientId,
        async (tokens) => {
          persisted = tokens;
        },
        deviceId,
      );
      const secondRefresh = await tokenRefreshFunction(refreshed.refreshToken!);
      expect(secondRefresh.accessToken).toBeTruthy();
      expect(secondRefresh.accessToken).not.toBe(refreshed.accessToken);
      expect(persisted).not.toBeNull();
      expect(persisted!.accessToken).toBe(secondRefresh.accessToken);

      const storage = await TeleCryptIOStorage.createFromOidc({
        baseUrl: HOMESERVER,
        serverName: "localhost:8008",
        userId: who.userId,
        accessToken: refreshed.accessToken,
        deviceId,
      });
      try {
        const vault = await core.createVault(storage, "OidcRefreshedTokenVault");
        expect(vault.id).toBeTruthy();
      } finally {
        storage.getClient().stopClient();
      }
    },
    45000,
  );
});
