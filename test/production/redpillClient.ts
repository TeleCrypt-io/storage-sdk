/**
 * Client for the public `redpill` endpoint, which provisions throwaway
 * accounts on REAL production telecrypt.io — no auth, no request body, no
 * secrets. See docs/PROD_TESTING_SPEC.md.
 *
 * Spiked live (2026-07-21): `POST https://telecrypt.io/redpill` returns a
 * fully usable account (`mxid`/`access_token`/`device_id`/`homeserver`) —
 * the token passes `/whoami` and can `createRoom` on real prod.
 *
 * RATE LIMIT: HAProxy caps this at 5/min per source IP. Callers MUST
 * provision serially (never `Promise.all`) and cap a single test run at
 * ~3 accounts — enforced here by `provisionRedpillAccounts` awaiting each
 * call in turn, never by parallelizing.
 */

const REDPILL_URL = "https://telecrypt.io/redpill";

export interface RedpillAccount {
  mxid: string;
  accessToken: string;
  deviceId: string;
  homeserver: string;
}

interface RedpillResponse {
  mxid?: string;
  access_token?: string;
  device_id?: string;
  homeserver?: string;
  adopt_instructions?: unknown;
}

/**
 * Provisions ONE throwaway account. Fails loudly (never silently) if
 * redpill is unreachable, rate-limited, or returns an incomplete account —
 * per the spec, a prod-suite run must not silently pass when it can't
 * actually reach prod.
 */
export async function provisionRedpillAccount(): Promise<RedpillAccount> {
  let res: Response;
  try {
    res = await fetch(REDPILL_URL, { method: "POST" });
  } catch (err) {
    throw new Error(
      `redpill unreachable at ${REDPILL_URL}: ${(err as Error).message} — is telecrypt.io down, or is this run offline?`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const rateLimitHint =
      res.status === 429
        ? " — rate limited (redpill allows 5/min per source IP; this suite provisions serially and caps at 3, so this likely means another process/run hit it recently — wait and retry, do not parallelize)"
        : "";
    throw new Error(`redpill provisioning failed (${res.status}): ${body || res.statusText}${rateLimitHint}`);
  }

  const data = (await res.json()) as RedpillResponse;
  if (!data.mxid || !data.access_token || !data.device_id || !data.homeserver) {
    throw new Error(`redpill returned an incomplete account: ${JSON.stringify(data)}`);
  }

  return {
    mxid: data.mxid,
    accessToken: data.access_token,
    deviceId: data.device_id,
    homeserver: data.homeserver,
  };
}

/**
 * Provisions `count` accounts SERIALLY. Never parallelize this — see the
 * rate-limit note above. All Part A provisioning must happen through this
 * one function, from a single `beforeAll`, in a single test file, so that
 * no other file's `beforeAll` can run concurrently and blow the 5/min cap.
 */
export async function provisionRedpillAccounts(count: number): Promise<RedpillAccount[]> {
  const accounts: RedpillAccount[] = [];
  for (let i = 0; i < count; i++) {
    accounts.push(await provisionRedpillAccount());
  }
  return accounts;
}
