// Empirical test: does MAS reuse a device when the SAME device_id is used
// for a second login? Uses the device-code flow (caller-chosen deviceId).
import { describe, it, expect } from "vitest";
import { registerTestUser } from "./harness/users";
import {
  discoverOidcIssuer,
  registerClient,
  startDeviceCodeLogin,
  waitForDeviceCodeLogin,
  isDeviceAccessTokenError,
  whoAmI,
} from "../src/core/oidc";
import { approveDeviceCodeViaHttp } from "./harness/oidcApproval";

const BASE_URL = "http://localhost:8008";

async function loginWithDeviceId(username: string, password: string, deviceId: string) {
  const metadata = await discoverOidcIssuer(BASE_URL);
  const clientId = await registerClient(metadata, {
    clientName: "device-reuse-test",
    clientUri: "https://example.test/",
    applicationType: "native",
    redirectUris: ["https://example.test/"],
    contacts: undefined,
    tosUri: undefined,
    policyUri: undefined,
  });
  const session = await startDeviceCodeLogin(metadata, clientId, deviceId);
  const [result] = await Promise.all([
    waitForDeviceCodeLogin(metadata, clientId, session),
    approveDeviceCodeViaHttp(username, password, session.user_code),
  ]);
  if (isDeviceAccessTokenError(result)) {
    throw new Error(`MAS rejected: ${result.error_description ?? result.error}`);
  }
  const identity = await whoAmI(BASE_URL, result.access_token);
  return { deviceId: identity.deviceId, accessToken: result.access_token };
}

describe("MAS device_id reuse", () => {
  it("reuses the same device when the same device_id is presented twice", async () => {
    const user = await registerTestUser("devreuse");
    const STABLE = "STABLE12345";
    const first = await loginWithDeviceId(user.userId, user.password, STABLE);
    expect(first.deviceId).toBe(STABLE);

    const second = await loginWithDeviceId(user.userId, user.password, STABLE);
    expect(second.deviceId).toBe(STABLE);

    // Both tokens must be valid (same device, two sessions).
    const who1 = await whoAmI(BASE_URL, first.accessToken);
    const who2 = await whoAmI(BASE_URL, second.accessToken);
    expect(who1.deviceId).toBe(STABLE);
    expect(who2.deviceId).toBe(STABLE);
  });
});
