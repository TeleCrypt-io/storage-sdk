/**
 * Approves a device grant against the disposable local MAS through its real
 * browser forms. This is test infrastructure only: the password is used
 * solely to approve MAS OAuth, never by the SDK's production login flow.
 */
const MAS_BASE = new URL("http://localhost:8008/auth/");

function localMasUrl(location: string): URL {
  const url = new URL(location, MAS_BASE);
  if (url.origin !== MAS_BASE.origin || url.username || url.password) {
    throw new Error(`approveDeviceCode: refusing non-local MAS URL ${location}`);
  }
  if (!url.pathname.startsWith(MAS_BASE.pathname)) {
    throw new Error(`approveDeviceCode: refusing non-MAS URL ${location}`);
  }
  return url;
}

function extractCsrf(html: string): string {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const input = match[0];
    const name = input.match(/\bname\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (name !== "csrf") continue;
    const value = input.match(/\bvalue\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (value) return value;
  }
  throw new Error("approveDeviceCode: no CSRF token on MAS page");
}

function extractFormAction(html: string, fallback: URL): string {
  const form = html.match(/<form\b[^>]*>/i)?.[0];
  if (!form) throw new Error("approveDeviceCode: no form on MAS page");
  const action = form.match(/\baction\s*=\s*(["'])(.*?)\1/i)?.[2];
  return new URL(action || fallback.toString(), fallback).toString();
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

  let response = await jar.get(new URL("login", MAS_BASE).toString());
  let csrf = extractCsrf(await response.text());
  response = await jar.post(new URL("login", MAS_BASE).toString(), { csrf, username, password });
  if (response.status !== 303) {
    throw new Error(`approveDeviceCode: login did not redirect (${response.status})`);
  }
  await jar.follow(response);

  const linkUrl = new URL("link", MAS_BASE);
  response = await jar.get(linkUrl.toString());
  const linkHtml = await response.text();
  if (response.status !== 200) {
    throw new Error(`approveDeviceCode: device-link form failed (${response.status})`);
  }
  csrf = extractCsrf(linkHtml);
  const linkAction = extractFormAction(linkHtml, linkUrl);
  response = await jar.post(linkAction, { csrf, code: userCode });
  const devicePath = response.headers.get("location");
  if (response.status !== 303 || !devicePath) {
    throw new Error(`approveDeviceCode: device-link submission failed (${response.status})`);
  }
  response = await jar.follow(response);

  if (response.status !== 200) {
    throw new Error(`approveDeviceCode: consent form failed (${response.status})`);
  }
  csrf = extractCsrf(await response.text());
  response = await jar.post(devicePath, { csrf, confirm_device: "on", action: "consent" });
  if (response.status !== 200) {
    throw new Error(`approveDeviceCode: consent failed (${response.status})`);
  }
}
