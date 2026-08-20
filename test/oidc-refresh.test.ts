import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshOidcToken } from "../src/core/oidc.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OIDC token refresh response validation", () => {
  it("requires a non-empty access token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ refresh_token: "next" })));

    await expect(refreshOidcToken("https://auth.example.test/token", "client", "refresh")).rejects.toThrow(
      "OIDC token refresh returned no access token",
    );
  });

  it("rejects malformed optional token fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response({ access_token: "access", refresh_token: 42 }))
        .mockResolvedValueOnce(response({ access_token: "access", expires_in: -1 })),
    );

    await expect(refreshOidcToken("https://auth.example.test/token", "client", "refresh")).rejects.toThrow(
      "OIDC token refresh returned an invalid refresh token",
    );
    await expect(refreshOidcToken("https://auth.example.test/token", "client", "refresh")).rejects.toThrow(
      "OIDC token refresh returned an invalid expiry",
    );
  });
});
