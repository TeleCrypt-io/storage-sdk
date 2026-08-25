import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import {
  discoverOidcIssuer,
  isDeviceAccessTokenError,
  registerClient,
  startDeviceCodeLogin,
  waitForDeviceCodeLogin,
  whoAmI,
} from "../../src/core/oidc.js";
import { approveDeviceCodeViaHttp } from "./oidcApproval.js";

const execFileAsync = promisify(execFile);
const HOMESERVER = "http://localhost:8008";
const PROVISIONING_RETRIES = 3;
const PROVISIONING_RETRY_DELAY_MS = 300;

export interface TestUser {
  userId: string;
  accessToken: string;
  deviceId: string;
  password: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export function newTestDeviceId(prefix: string): string {
  // MAS requires device IDs to use its restricted character set and contain
  // at least ten characters.
  return `${prefix}${randomBytes(8).toString("hex").toUpperCase()}`;
}

/** Creates a throwaway MAS account through the local disposable stack. */
export async function registerUserInMas(username: string, password: string): Promise<void> {
  const args = [
    "exec",
    "throwaway-mas",
    "mas-cli",
    "manage",
    "register-user",
    username,
    "--password",
    password,
    "--yes",
    "--ignore-password-complexity",
    "-c",
    "/data/config.yaml",
  ];

  // Immediately after the disposable stack starts, MAS can briefly fail to
  // resolve its Postgres hostname. Retry only that transient failure.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await execFileAsync("podman", args);
      return;
    } catch (err) {
      const e = err as { stdout?: unknown; stderr?: unknown };
      const output = [e.stderr, e.stdout].filter((value): value is string => typeof value === "string").join("\n");
      if (!output.includes("Temporary failure in name resolution") || attempt === 3) {
        // Do not propagate execFile's message or command output: both may
        // contain the generated --password argument.
        throw new Error("mas-cli register-user failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

interface DeviceLogin {
  userId: string;
  accessToken: string;
  deviceId: string;
}

function localpartFromUserId(userId: string): string {
  const match = userId.match(/^@([^:]+):(.+)$/);
  if (!match) throw new Error(`invalid Matrix user id returned by MAS: ${userId}`);
  return match[1];
}

function isProvisioningRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:failed to provision(?: device)?|user not found|failed to create device)/i.test(message);
}

async function loginViaDeviceCode(
  username: string,
  password: string,
  deviceId: string,
): Promise<DeviceLogin> {
  const authMetadata = await discoverOidcIssuer(HOMESERVER);
  const clientId = await registerClient(authMetadata, {
    clientName: "TeleCrypt.io disposable test",
    clientUri: "http://localhost:1234/",
    applicationType: "native",
    redirectUris: ["http://localhost:1234/callback"],
    contacts: undefined,
    tosUri: undefined,
    policyUri: undefined,
  });
  const session = await startDeviceCodeLogin(authMetadata, clientId, deviceId);
  const [result] = await Promise.all([
    waitForDeviceCodeLogin(authMetadata, clientId, session),
    approveDeviceCodeViaHttp(username, password, session.user_code),
  ]);
  if (isDeviceAccessTokenError(result)) {
    throw new Error(`device-code login failed (${result.error}): ${result.error_description ?? "no description"}`);
  }

  const identity = await whoAmI(HOMESERVER, result.access_token, "localhost:8008");
  if (identity.deviceId !== deviceId) {
    throw new Error(
      `device-code login returned device ${identity.deviceId ?? "none"}, expected ${deviceId}`,
    );
  }
  return { userId: identity.userId, accessToken: result.access_token, deviceId };
}

/**
 * MAS creates the Matrix-side account asynchronously. The device-code grant
 * already polls its token endpoint; retry the whole grant only if MAS reports
 * the specific provisioning race, never for an authentication or approval
 * failure.
 */
async function loginAfterProvisioning(
  username: string,
  password: string,
  deviceId: string,
): Promise<DeviceLogin> {
  for (let attempt = 1; attempt <= PROVISIONING_RETRIES; attempt++) {
    try {
      return await loginViaDeviceCode(username, password, deviceId);
    } catch (error) {
      if (!isProvisioningRace(error) || attempt === PROVISIONING_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, PROVISIONING_RETRY_DELAY_MS));
    }
  }
  throw new Error("device-code provisioning retry exhausted");
}

export async function registerTestUser(prefix: string): Promise<TestUser> {
  const suffix = randomSuffix();
  const username = `${prefix}_${suffix}`.toLowerCase();
  const password = `pwd_${suffix}`;
  const deviceId = newTestDeviceId("TC");

  await registerUserInMas(username, password);
  const data = await loginAfterProvisioning(username, password, deviceId);
  return { ...data, password };
}

/** Registers a user and obtains a device-code session to confirm provisioning. */
export async function registerAndWaitForMasProvisioning(
  username: string,
  password: string,
): Promise<void> {
  await registerUserInMas(username, password);
  await loginAfterProvisioning(username, password, newTestDeviceId("TCWAIT"));
}

/** Obtains a second explicit Matrix device through MAS's OIDC flow. */
export async function loginNewDevice(user: TestUser): Promise<TestUser> {
  const data = await loginAfterProvisioning(
    localpartFromUserId(user.userId),
    user.password,
    newTestDeviceId("TCNEW"),
  );
  if (data.deviceId === user.deviceId) {
    throw new Error(`loginNewDevice returned the original device ${data.deviceId}`);
  }
  return { ...data, password: user.password };
}
