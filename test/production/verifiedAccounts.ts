/**
 * Logs in the dedicated, operator-VERIFIED production test accounts from
 * env/secrets (PROD_TEST_USER_1/PROD_TEST_PASS_1, PROD_TEST_USER_2/
 * PROD_TEST_PASS_2). Unlike redpill accounts (unverified → media uploads
 * blocked), these are marked `verified` by the operator, so the full
 * upload/share round-trip actually runs on real prod.
 *
 * Auth path: plain `m.login.password` (compat, works while telecrypt.io's
 * MAS runs in compatibility mode) — the suite never needs a raw password
 * beyond this login; it uses the resulting access token like any other.
 *
 * Returns the SAME shape as a redpill account so storage.test.ts can use
 * either source interchangeably. Returns `null` when the env vars aren't
 * set, so a local run without secrets falls back to redpill cleanly.
 */
import type { RedpillAccount } from "./redpillClient";

const HOMESERVER = process.env.PROD_HOMESERVER ?? "https://telecrypt.io";

async function loginPassword(user: string, password: string): Promise<RedpillAccount> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user },
      password,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `verified test account "${user}" failed to log in (${res.status}): ${body || res.statusText}`,
    );
  }
  const data = (await res.json()) as {
    user_id?: string;
    access_token?: string;
    device_id?: string;
  };
  if (!data.user_id || !data.access_token || !data.device_id) {
    throw new Error(`login for "${user}" returned an incomplete session: ${JSON.stringify(data)}`);
  }
  return {
    mxid: data.user_id,
    accessToken: data.access_token,
    deviceId: data.device_id,
    homeserver: HOMESERVER,
  };
}

/**
 * Logs in the two verified test accounts if their env vars are all present;
 * otherwise returns `null` (caller falls back to redpill). Serial logins.
 */
export async function loginVerifiedAccounts(): Promise<RedpillAccount[] | null> {
  const u1 = process.env.PROD_TEST_USER_1;
  const p1 = process.env.PROD_TEST_PASS_1;
  const u2 = process.env.PROD_TEST_USER_2;
  const p2 = process.env.PROD_TEST_PASS_2;
  if (!u1 || !p1 || !u2 || !p2) return null;

  const a = await loginPassword(u1, p1);
  const b = await loginPassword(u2, p2);
  return [a, b];
}
