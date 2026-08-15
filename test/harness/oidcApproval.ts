/**
 * Approves a device grant against the disposable local MAS through its real
 * browser forms. This is test infrastructure only: the password is used
 * solely to approve MAS OAuth, never by the SDK or Matrix's compatibility
 * login endpoint.
 */
const MAS_BASE = new URL("http://localhost:8082/");

function localMasUrl(location: string): URL {
  const url = new URL(location, MAS_BASE);
  if (url.origin !== MAS_BASE.origin || url.username || url.password) {
    throw new Error(`approveDeviceCode: refusing non-local MAS URL ${location}`);
  }
  return url;
}

function extractCsrf(html: string): string {
  // MAS 1.16 emits `<input type="hidden" name="csrf" value="…">`.
  // Attribute order is not semantically meaningful, so do not couple this
  // test-only browser-form adapter to one particular template serialization.
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const input = match[0];
    const name = input.match(/\bname\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (name !== "csrf") continue;
    const value = input.match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (value) return value;
  }
  throw new Error("approveDeviceCode: no CSRF token on MAS page");
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  private update(response: Response): void {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(";");
      const equals = pair.indexOf("=");
      if (equals <= 0) throw new Error("approveDeviceCode: malformed Set-Cookie header");
      const name = pair.slice(0, equals);
      const value = pair.slice(equals + 1);
      this.cookies.set(name, value);
    }
  }

  private header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async get(location: string): Promise<Response> {
    const response = await fetch(localMasUrl(location), {
      headers: { Cookie: this.header() },
      redirect: "manual",
    });
    this.update(response);
    return response;
  }

  async post(location: string, fields: Record<string, string>): Promise<Response> {
    const response = await fetch(localMasUrl(location), {
      method: "POST",
      headers: {
        Cookie: this.header(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });
    this.update(response);
    return response;
  }

  async follow(response: Response): Promise<Response> {
    let current = response;
    for (let redirects = 0; redirects < 10; redirects++) {
      const location = current.headers.get("location");
      if (current.status < 300 || current.status >= 400 || !location) return current;
      current = await this.get(location);
    }
    throw new Error("approveDeviceCode: too many MAS redirects");
  }
}

/**
 * Logs in as `username`/`password` on MAS's real login page, enters the
 * device code, and approves the consent screen. Any unexpected redirect or
 * form response fails the test rather than becoming a silent no-op.
 */
export async function approveDeviceCodeViaHttp(
  username: string,
  password: string,
  userCode: string,
): Promise<void> {
  const jar = new CookieJar();

  let response = await jar.get("/login");
  let csrf = extractCsrf(await response.text());
  response = await jar.post("/login", { csrf, username, password });
  if (response.status !== 303) {
    throw new Error(`approveDeviceCode: login did not redirect (${response.status})`);
  }
  await jar.follow(response);

  // MAS 1.16's `/link` form is a GET carrying only the user code; it has no
  // CSRF field. Keep the generated URL local and let localMasUrl validate it.
  const linkUrl = new URL("/link", MAS_BASE);
  linkUrl.searchParams.set("code", userCode);
  response = await jar.get(`${linkUrl.pathname}${linkUrl.search}`);
  const devicePath = response.headers.get("location");
  if (response.status !== 303 || !devicePath) {
    throw new Error(`approveDeviceCode: device-link did not redirect (${response.status})`);
  }
  response = await jar.follow(response);

  csrf = extractCsrf(await response.text());
  response = await jar.post(devicePath, { csrf, confirm_device: "on", action: "consent" });
  if (response.status !== 200) {
    throw new Error(`approveDeviceCode: consent failed (${response.status})`);
  }
}
