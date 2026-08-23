import { afterEach, describe, expect, it, vi } from "vitest";
import { approveDeviceCodeViaHttp } from "./harness/oidcApproval.js";

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local MAS device approval", () => {
  it("uses the MAS login, device-link, and consent forms with CSRF and preserved cookies", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(response('<input value="login-csrf" type="hidden" name="csrf">'))
      .mockResolvedValueOnce(
        response("", 303, {
          location: "/auth/after-login",
          "set-cookie": "session=contains=equals; Path=/; HttpOnly",
        }),
      )
      .mockResolvedValueOnce(response("logged in"))
      .mockResolvedValueOnce(response('<form method="POST"><input type="hidden" name="csrf" value="link-csrf"></form>'))
      .mockResolvedValueOnce(response("", 303, { location: "/auth/authorize/device" }))
      .mockResolvedValueOnce(response('<input type="hidden" name="csrf" value="consent-csrf">'))
      .mockResolvedValueOnce(response("approved"));

    await approveDeviceCodeViaHttp("alice", "test-only-password", "ABC-123");

    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual([
      "/auth/login",
      "/auth/login",
      "/auth/after-login",
      "/auth/link",
      "/auth/link",
      "/auth/authorize/device",
      "/auth/authorize/device",
    ]);
    const login = new URLSearchParams(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(Object.fromEntries(login)).toEqual({
      csrf: "login-csrf",
      username: "alice",
      password: "test-only-password",
    });
    const deviceLink = new URLSearchParams(String(fetchMock.mock.calls[4]?.[1]?.body));
    expect(Object.fromEntries(deviceLink)).toEqual({ csrf: "link-csrf", code: "ABC-123" });
    const consent = new URLSearchParams(String(fetchMock.mock.calls[6]?.[1]?.body));
    expect(Object.fromEntries(consent)).toEqual({
      csrf: "consent-csrf",
      confirm_device: "on",
      action: "consent",
    });
    expect((fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>).Cookie).toBe(
      "session=contains=equals",
    );
  });

  it("fails closed when MAS redirects the approval flow away from localhost", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(response('<input type="hidden" name="csrf" value="login-csrf">'))
      .mockResolvedValueOnce(response("", 303, { location: "https://example.invalid/" }));

    await expect(approveDeviceCodeViaHttp("alice", "test-only-password", "ABC-123")).rejects.toThrow(
      /refusing non-local MAS URL/,
    );
  });

  it("reports a rejected consent form instead of treating its body as a valid form", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(response('<input type="hidden" name="csrf" value="login-csrf">'))
      .mockResolvedValueOnce(response("", 303, { location: "/auth/after-login" }))
      .mockResolvedValueOnce(response("logged in"))
      .mockResolvedValueOnce(
        response('<form method="POST"><input type="hidden" name="csrf" value="link-csrf"></form>'),
      )
      .mockResolvedValueOnce(response("", 303, { location: "/auth/authorize/device" }))
      .mockResolvedValueOnce(response("policy rejected", 500));

    await expect(approveDeviceCodeViaHttp("alice", "test-only-password", "ABC-123")).rejects.toThrow(
      /consent form failed \(500\)/,
    );
  });
});
