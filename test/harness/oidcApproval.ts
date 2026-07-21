/**
 * Approves an OIDC device-code grant against the local MAS the exact way a
 * human would in a browser (login form -> device-link form -> consent form)
 * but driven headlessly over plain HTTP with a hand-rolled cookie jar — MAS's
 * pages are plain server-rendered forms with CSRF tokens, no JS challenge,
 * so this needs no browser. Verified against throwaway_synapse's MAS during
 * development (see docs/DECISIONS.md D6) before writing test/functional/oidc.test.ts
 * against it. Test-only: the test acts as "the approving party" because it
 * controls the dev MAS and the test user's real password — see
 * docs/OAUTH_SPEC.md's testing note on this.
 */
const MAS_BASE = "http://localhost:8082";

function extractCsrf(html: string): string {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error("approveDeviceCode: no csrf token found on MAS page");
  return m[1];
}

class CookieJar {
  private jar = new Map<string, string>();

  private update(res: Response): void {
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(";");
      const [name, value] = pair.split("=");
      this.jar.set(name, value);
    }
  }

  private header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async get(path: string): Promise<Response> {
    const res = await fetch(MAS_BASE + path, { headers: { Cookie: this.header() }, redirect: "manual" });
    this.update(res);
    return res;
  }

  async postForm(path: string, fields: Record<string, string>): Promise<Response> {
    const res = await fetch(MAS_BASE + path, {
      method: "POST",
      headers: { Cookie: this.header(), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
    this.update(res);
    return res;
  }

  /** Follows 3xx redirects (bounded), re-issuing GETs with the accumulated
   * cookies — `fetch`'s own redirect handling doesn't carry cookies we set
   * manually across hosts/paths the way a browser would. */
  async follow(res: Response): Promise<Response> {
    let current = res;
    let loc = current.headers.get("location");
    let i = 0;
    while (current.status >= 300 && current.status < 400 && loc && i < 10) {
      current = await this.get(loc.startsWith("http") ? loc.replace(MAS_BASE, "") : loc);
      loc = current.headers.get("location");
      i++;
    }
    return current;
  }
}

/**
 * Logs in as `username`/`password` on MAS's real login page, enters
 * `userCode` on the device-link page, and approves the consent screen.
 * Throws if any step doesn't produce the expected redirect (a login/consent
 * failure surfaces as a test failure, not a silent no-op).
 */
export async function approveDeviceCodeViaHttp(
  username: string,
  password: string,
  userCode: string,
): Promise<void> {
  const jar = new CookieJar();

  let res = await jar.get("/login");
  let html = await res.text();
  let csrf = extractCsrf(html);
  res = await jar.postForm("/login", { csrf, username, password });
  if (res.status !== 303) {
    throw new Error(`approveDeviceCode: login POST did not redirect (status ${res.status})`);
  }
  res = await jar.follow(res);
  html = await res.text();

  res = await jar.get("/link");
  html = await res.text();
  csrf = extractCsrf(html);
  res = await jar.postForm("/link", { csrf, code: userCode });
  const devicePath = res.headers.get("location");
  if (res.status !== 303 || !devicePath) {
    throw new Error(`approveDeviceCode: entering the user code did not redirect (status ${res.status})`);
  }
  res = await jar.follow(res);
  html = await res.text();

  csrf = extractCsrf(html);
  res = await jar.postForm(devicePath, { csrf, confirm_device: "on", action: "consent" });
  if (res.status !== 200) {
    throw new Error(`approveDeviceCode: consent POST failed (status ${res.status})`);
  }
}
