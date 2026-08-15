import { afterEach, describe, expect, it, vi } from "vitest";
import { approveDeviceCodeViaHttp } from "./harness/oidcApproval.js";

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local MAS device approval", () => {
  it("uses the MAS 1.16 login, link, and consent forms with CSRF and preserved cookies", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock
      .mockResolvedValueOnce(response('<input value="login-csrf" type="hidden" name="csrf">'))
      .mockResolvedValueOnce(
        response("", 303, {
          location: "/after-login",
          "set-cookie": "session=contains=equals; Path=/; HttpOnly",
        }),
      )
      .mockResolvedValueOnce(response("logged in"))
      .mockResolvedValueOnce(response("", 303, { location: "/authorize/device" }))
      .mockResolvedValueOnce(response('<input type="hidden" name="csrf" value="consent-csrf">'))
      .mockResolvedValueOnce(response("approved"));

    await approveDeviceCodeViaHttp("alice", "test-only-password", "ABC-123");

    const paths = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(paths).toEqual(["/login", "/login", "/after-login", "/link", "/authorize/device", "/authorize/device"]);
    const login = new URLSearchParams(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(Object.fromEntries(login)).toEqual({
      csrf: "login-csrf",
      username: "alice",
      password: "test-only-password",
    });
    expect(new URL(String(fetchMock.mock.calls[3]?.[0])).searchParams.get("code")).toBe("ABC-123");
    const consent = new URLSearchParams(String(fetchMock.mock.calls[5]?.[1]?.body));
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
});
