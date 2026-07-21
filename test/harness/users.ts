import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TestUser {
  userId: string;
  accessToken: string;
  deviceId: string;
  password: string;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * The throwaway stack's Synapse delegates auth to a local MAS (MSC3861,
 * compatibility mode — see throwaway_synapse/up.sh and docs/DECISIONS.md D6).
 * Under delegation Synapse refuses plain `POST /_matrix/client/v3/register`
 * (confirmed: 403 "Registration has been disabled") — MAS owns account
 * creation now. `mas-cli manage register-user` is the scriptable way to
 * create one non-interactively; it runs inside the MAS container, so this
 * shells out via `podman exec`. This is the ONE change from the pre-MAS
 * harness: password login (below) is completely unchanged, still a plain
 * `POST /_matrix/client/v3/login`, now transparently proxied by the
 * throwaway front door (Caddy, :8008) to MAS's compat endpoint.
 */
export async function registerUserInMas(username: string, password: string): Promise<void> {
  try {
    await execFileAsync("podman", [
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
    ]);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `mas-cli register-user failed for "${username}": ${e.stderr || e.stdout || e.message}`,
    );
  }
}

/**
 * MAS provisions the corresponding Synapse-side user account
 * *asynchronously* — `mas-cli manage register-user` returns as soon as the
 * account exists in MAS's own database, but a background `provision-user`
 * job is what actually creates the account + device on Synapse (confirmed
 * via MAS's own logs: `job-provision-user` / `job-sync-devices`, and a
 * transient `POST /_matrix/client/v3/login` 500 — "failed to provision
 * device", Synapse 404 "User not found" on `/_synapse/mas/upsert_device` —
 * when login is attempted before that job runs). Under light load the job
 * finishes well within the gap between registration and login; under this
 * suite's full concurrent load (multiple test files registering/logging in
 * at once) the race becomes visible. Retrying login specifically on a 500
 * polls the real condition (MAS's own response) rather than guessing a
 * fixed delay — any other status fails fast, not retried.
 */
async function loginWithRetry(
  username: string,
  password: string,
  attempts = 20,
  delayMs = 300,
): Promise<{ user_id: string; access_token: string; device_id: string }> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await fetch("http://localhost:8008/_matrix/client/v3/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username },
        password,
      }),
    });
    if (res.ok) {
      return (await res.json()) as { user_id: string; access_token: string; device_id: string };
    }
    const body = await res.text();
    if (res.status !== 500 || attempt === attempts) {
      throw new Error(`login (after MAS registration) failed (${res.status}): ${body}`);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Unreachable (loop always returns or throws), but keeps TS happy.
  throw new Error("loginWithRetry: exhausted attempts");
}

export async function registerTestUser(prefix: string): Promise<TestUser> {
  const suffix = randomSuffix();
  // MAS enforces the Matrix user ID grammar strictly (lowercase localpart) —
  // the old plain Synapse POST /register silently accepted/normalised mixed
  // case, `mas-cli manage register-user` does not ("Username not available
  // on homeserver" for anything with an uppercase letter). Lowercase
  // defensively here so every caller's prefix (some historically mixed-case,
  // e.g. cli.test.ts's "multiA") just works.
  const username = `${prefix}_${suffix}`.toLowerCase();
  const password = `pwd_${suffix}`;

  await registerUserInMas(username, password);
  const data = await loginWithRetry(username, password);

  return {
    userId: data.user_id,
    accessToken: data.access_token,
    deviceId: data.device_id,
    password,
  };
}

/**
 * Registers a user via MAS and confirms (via `loginWithRetry`, discarding
 * the resulting session) that Synapse-side provisioning has actually
 * finished — for callers that need to drive their OWN login afterwards
 * (e.g. cli.test.ts's `registerProfile`, which runs the CLI's `storage
 * login` as a real subprocess) and would otherwise be exposed to the same
 * transient provisioning race `registerTestUser` retries around internally.
 */
export async function registerAndWaitForMasProvisioning(
  username: string,
  password: string,
): Promise<void> {
  await registerUserInMas(username, password);
  await loginWithRetry(username, password);
}

/**
 * Logs in as an existing user to obtain a SECOND, independent device: a new
 * device_id + access_token, with an empty crypto store of its own. This is the
 * "new laptop" scenario for key-recovery testing — distinct from `user`'s
 * original session, which keeps its own device_id/accessToken untouched.
 */
export async function loginNewDevice(user: TestUser): Promise<TestUser> {
  const res = await fetch("http://localhost:8008/_matrix/client/v3/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: user.userId },
      password: user.password,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`login (new device) failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    user_id: string;
    access_token: string;
    device_id: string;
  };

  if (data.device_id === user.deviceId) {
    throw new Error(
      `loginNewDevice: expected a NEW device_id, got the same one as the original session (${data.device_id})`,
    );
  }

  return {
    userId: data.user_id,
    accessToken: data.access_token,
    deviceId: data.device_id,
    password: user.password,
  };
}
