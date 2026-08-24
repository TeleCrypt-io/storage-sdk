import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTokenRefreshFunction,
  discoverOidcIssuer,
  registerClient,
  startDeviceCodeLogin,
  waitForDeviceCodeLogin,
  whoAmI,
  type OidcClientConfig,
} from "../src/core/oidc.js";

const REFRESH_METADATA = {
  issuer: "https://auth.example.test/",
  token_endpoint: "https://auth.example.test/token",
  revocation_endpoint: "https://auth.example.test/revoke",
} as const;

function refreshWithNoopPersistence(): (refreshToken: string, signal?: AbortSignal) => Promise<{
  accessToken: string;
  refreshToken?: string;
  expiry?: Date;
}> {
  return buildTokenRefreshFunction(REFRESH_METADATA, "client", async () => {}, "DEVICE123");
}

function response(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders ?? { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OIDC token refresh response validation", () => {
  it("propagates caller cancellation to the refresh request", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const pending = refreshWithNoopPersistence()("refresh", controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toThrow("OIDC token refresh cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the prior refresh token when the provider omits it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          access_token: "next-access",
          token_type: "Bearer",
          scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE123",
        }),
      ),
    );
    await expect(refreshWithNoopPersistence()("prior-refresh")).resolves.toMatchObject({
      accessToken: "next-access",
      refreshToken: "prior-refresh",
    });
  });

  it("rejects a refresh scope bound to a different Matrix device", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          access_token: "next-access",
          token_type: "Bearer",
          scope: "urn:matrix:client:api:* urn:matrix:client:device:OTHER",
        }),
      ),
    );
    const refresh = buildTokenRefreshFunction(
      REFRESH_METADATA,
      "client",
      async () => {},
      "DEVICE123",
    );
    await expect(refresh("prior-refresh")).rejects.toThrow("unexpected granted scope");
  });

  it("rejects a refresh response without a device-bound scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ access_token: "next-access", token_type: "Bearer" })),
    );
    await expect(refreshWithNoopPersistence()("prior-refresh")).rejects.toThrow(
      "no device-bound scope",
    );
  });

  it("requires a non-empty access token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ refresh_token: "next" })));

    await expect(refreshWithNoopPersistence()("refresh")).rejects.toThrow(
      "OIDC token refresh returned no access token",
    );
  });

  it("rejects malformed optional token fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response({
          access_token: "access",
          token_type: "Bearer",
          refresh_token: 42,
          scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE123",
        }))
        .mockResolvedValueOnce(response({
          access_token: "access",
          token_type: "Bearer",
          expires_in: -1,
          scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE123",
        })),
    );

    await expect(refreshWithNoopPersistence()("refresh")).rejects.toThrow(
      "OIDC token refresh returned an invalid refresh token",
    );
    await expect(refreshWithNoopPersistence()("refresh")).rejects.toThrow(
      "OIDC token refresh returned an invalid expiry",
    );
  });

  it("keeps only the standard OAuth error code", async () => {
    const secret = "refresh-secret-value";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            error: "invalid_grant",
            error_description: `refresh_token=${secret}; authorization: Bearer bearer-secret-value`,
            error_uri: "https://auth.example.test/errors/invalid_grant",
            ignored_secret: "must-not-appear",
          },
          400,
        ),
      ),
    );

    let caught: unknown;
    try {
      await refreshWithNoopPersistence()("refresh");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("(400)");
    expect(message).toContain("invalid_grant");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("bearer-secret-value");
    expect(message).not.toContain("must-not-appear");
    expect(message).not.toContain("refresh_token");
    expect(message).not.toContain("error_description");
    expect(message).not.toContain("error_uri");
  });

  it("does not retain an oversized provider error response", async () => {
    const secret = "oversized-refresh-secret";
    const oversized = {
      error: "invalid_grant",
      error_description: `refresh_token=${secret}`,
      padding: "x".repeat(20_000),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(oversized, 400)));

    let caught: unknown;
    try {
      await refreshWithNoopPersistence()("refresh");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("provider error response was too large");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("invalid_grant");
  });

  it("bounds an oversized successful token response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ access_token: "access", padding: "x".repeat(40_000) })),
    );
    await expect(refreshWithNoopPersistence()("refresh")).rejects.toThrow(
      "OIDC token refresh returned an oversized response",
    );
  });

  it("aborts a refresh that exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, options: { signal: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          }),
        ),
      );
      const pending = refreshWithNoopPersistence()("refresh");
      const assertion = expect(pending).rejects.toThrow("OIDC token refresh timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a refresh deadline when fetch ignores AbortSignal", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
      const pending = refreshWithNoopPersistence()("refresh");
      const assertion = expect(pending).rejects.toThrow("OIDC token refresh timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a persistence adapter that ignores its cancellation signal", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(response({
          access_token: "next-access",
          refresh_token: "next-refresh",
          token_type: "Bearer",
          scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE123",
        }))
        .mockResolvedValueOnce(response({}))
        .mockResolvedValueOnce(response({}));
      vi.stubGlobal("fetch", fetchMock);
      let persistenceSignal: AbortSignal | undefined;
      const refresh = buildTokenRefreshFunction(
        REFRESH_METADATA,
        "client",
        async (_tokens, signal) => {
          persistenceSignal = signal;
          await new Promise<void>(() => undefined);
        },
        "DEVICE123",
      );
      const pending = refresh("old-refresh");
      const assertion = expect(pending).rejects.toThrow("persistence failed; discard");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(persistenceSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("revokes refreshed tokens after persistence cancellation using a live cleanup signal", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({
        access_token: "next-access",
        refresh_token: "next-refresh",
        token_type: "Bearer",
        scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE123",
      }))
      .mockResolvedValue(response({}));
    vi.stubGlobal("fetch", fetchMock);
    let persistenceSignal: AbortSignal | undefined;
    const refresh = buildTokenRefreshFunction(
      REFRESH_METADATA,
      "client",
      async (_tokens, signal) => {
        persistenceSignal = signal;
        await new Promise<void>(() => undefined);
      },
      "DEVICE123",
    );
    const pending = refresh("old-refresh", controller.signal);
    await vi.waitFor(() => expect(persistenceSignal).toBeDefined());
    controller.abort();

    await expect(pending).rejects.toThrow("persistence failed; discard");
    expect(persistenceSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls.slice(1)) {
      const cleanupSignal = (call[1] as RequestInit).signal;
      expect(cleanupSignal).toBeDefined();
      expect(cleanupSignal).not.toBe(controller.signal);
      expect(cleanupSignal?.aborted).toBe(false);
    }
  });

  it.each([302, 307, 308])("rejects a token-endpoint %s redirect without following it", async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(
      response("", status, { location: "https://evil.example.test/token" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshWithNoopPersistence()("refresh")).rejects.toThrow(
      "OIDC token refresh rejected an untrusted redirect",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("rejects a token endpoint with a query or fragment", () => {
    expect(() =>
      buildTokenRefreshFunction(
        {
          ...REFRESH_METADATA,
          token_endpoint: "https://auth.example.test/token?redirect=https://evil.example.test",
        },
        "client",
        async () => {},
        "DEVICE123",
      ),
    ).toThrow("invalid token endpoint");
  });

  it("binds refresh and revocation endpoints to the issuer", () => {
    expect(() =>
      buildTokenRefreshFunction(
        { ...REFRESH_METADATA, token_endpoint: "https://evil.example.test/token" },
        "client",
        async () => {},
        "DEVICE123",
      ),
    ).toThrow("outside the validated issuer");
    expect(() =>
      buildTokenRefreshFunction(
        { ...REFRESH_METADATA, revocation_endpoint: "https://evil.example.test/revoke" },
        "client",
        async () => {},
        "DEVICE123",
      ),
    ).toThrow("outside the validated issuer");
  });

  it("revokes rotated tokens when persistence fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({
        access_token: "next-access",
        refresh_token: "next-refresh",
        token_type: "Bearer",
        scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE123",
      }))
      .mockResolvedValueOnce(response({}, 200))
      .mockResolvedValueOnce(response({}, 200));
    vi.stubGlobal("fetch", fetchMock);
    const refresh = buildTokenRefreshFunction(
      REFRESH_METADATA,
      "client",
      async () => {
        throw new Error("stale session");
      },
      "DEVICE123",
    );

    await expect(refresh("old-refresh")).rejects.toThrow("persistence failed; discard");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new URL(fetchMock.mock.calls[1]?.[0] as string).pathname).toBe("/revoke");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).body).toContain("next-access");
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).body).toContain("next-refresh");
  });
});

const OAUTH_METADATA: OidcClientConfig = {
  issuer: "https://auth.example.test/",
  authorization_endpoint: "https://auth.example.test/authorize",
  device_authorization_endpoint: "https://auth.example.test/device",
  registration_endpoint: "https://auth.example.test/register",
  token_endpoint: "https://auth.example.test/token",
  revocation_endpoint: "https://auth.example.test/revoke",
  response_modes_supported: ["query", "fragment"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  code_challenge_methods_supported: ["S256"],
};

describe("Matrix 42 OAuth migration", () => {
  it("accepts discovery metadata without an optional revocation endpoint", async () => {
    const withoutRevocation = { ...OAUTH_METADATA, revocation_endpoint: undefined };
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => Promise.resolve(response(withoutRevocation))));

    await expect(discoverOidcIssuer("https://homeserver.example.test")).resolves.toMatchObject({
      issuer: OAUTH_METADATA.issuer,
      token_endpoint: OAUTH_METADATA.token_endpoint,
    });
    const result = await discoverOidcIssuer("https://homeserver.example.test");
    expect(result.revocation_endpoint).toBeUndefined();
  });

  it("uses the exact stable auth-metadata endpoint without the raw Matrix HTTP client", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(OAUTH_METADATA));
    vi.stubGlobal("fetch", fetchMock);

    await discoverOidcIssuer("https://homeserver.example.test");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://homeserver.example.test/_matrix/client/v1/auth_metadata",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
      }),
    );
  });

  it("appends discovery to a homeserver path without replacing that path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(OAUTH_METADATA));
    vi.stubGlobal("fetch", fetchMock);

    await discoverOidcIssuer("https://homeserver.example.test/matrix/");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://homeserver.example.test/matrix/_matrix/client/v1/auth_metadata",
    );
  });

  it("keeps refresh persistence cleanup opportunistic when revocation is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({
        access_token: "next-access",
        token_type: "Bearer",
        scope: "urn:matrix:client:api:* urn:matrix:client:device:DEVICE123",
      })),
    );
    const refresh = buildTokenRefreshFunction(
      { ...REFRESH_METADATA, revocation_endpoint: undefined },
      "client",
      async () => {
        throw new Error("stale session");
      },
      "DEVICE123",
    );

    await expect(refresh("old-refresh")).rejects.toThrow(
      "OIDC token persistence failed; discard the refreshed session",
    );
  });

  it("rejects remote cleartext homeservers before discovery", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(discoverOidcIssuer("http://homeserver.example.test")).rejects.toThrow(
      "OIDC discovery failed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds discovery provider failures without exposing provider text", async () => {
    const secret = "discovery-refresh-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            error: `refresh_token=${secret};${"x".repeat(20_000)}`,
          },
          502,
        ),
      ),
    );

    let caught: unknown;
    try {
      await discoverOidcIssuer("https://homeserver.example.test");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("OIDC discovery failed (502)");
    expect(message).toBe("OIDC discovery failed (502)");
    expect(message).not.toContain(secret);
  });

  it("does not expose a registration error body", async () => {
    const secret = "registration-client-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            error: `client_secret=${secret};${"x".repeat(20_000)}`,
          },
          400,
        ),
      ),
    );

    let caught: unknown;
    try {
      await registerClient(OAUTH_METADATA, {
        clientUri: "https://telecrypt.io/",
        redirectUris: ["https://telecrypt.io/callback"],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toBe("OIDC dynamic client registration failed");
    expect(message).not.toContain(secret);
    expect(message.length).toBeLessThan(200);
  });

  it("rejects DCR redirects outside the client origin", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      registerClient(OAUTH_METADATA, {
        clientUri: "https://telecrypt.io/",
        redirectUris: ["https://evil.example.test/callback"],
      }),
    ).rejects.toThrow("OIDC dynamic client registration failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds public device-code inputs before a token request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(startDeviceCodeLogin(OAUTH_METADATA, "client id", "DEVICE123")).rejects.toThrow(
      "OIDC device authorization failed",
    );
    await expect(startDeviceCodeLogin(OAUTH_METADATA, "client-id", "D".repeat(129))).rejects.toThrow(
      "OIDC device authorization failed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds an oversized device authorization response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ device_code: "device", user_code: "code", verification_uri: "https://auth.example.test/device", expires_in: 60, padding: "x".repeat(40_000) }),
      ),
    );

    await expect(startDeviceCodeLogin(OAUTH_METADATA, "client-id", "DEVICE123")).rejects.toThrow(
      "OIDC device authorization failed",
    );
  });

  it("accepts the MAS twenty-minute device-code lifetime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          device_code: "device",
          user_code: "code",
          verification_uri: "https://auth.example.test/device",
          expires_in: 20 * 60,
        }),
      ),
    );

    await expect(startDeviceCodeLogin(OAUTH_METADATA, "client-id", "DEVICE123")).resolves.toMatchObject({
      device_code: "device",
      user_code: "code",
      expires_in: 20 * 60,
    });
  });

  it("aborts a device authorization request that exceeds its deadline", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const pending = startDeviceCodeLogin(OAUTH_METADATA, "client-id", "DEVICE123");
      const assertion = expect(pending).rejects.toThrow("OIDC device authorization timed out");
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds an oversized device polling response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ error: "authorization_pending", padding: "x".repeat(20_000) }, 400),
      ),
    );

    await expect(
      waitForDeviceCodeLogin(OAUTH_METADATA, "client-id", {
        device_code: "device-code",
        user_code: "ABCD",
        verification_uri: "https://auth.example.test/device",
        expires_in: 1,
        interval: 1,
      },
      undefined,
      "DEVICE123",
      ),
    ).rejects.toThrow("OIDC device authorization failed");
  });

  it("rejects a device token granted for a different device", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        device_code: "device-code",
        user_code: "ABCD",
        verification_uri: "https://auth.example.test/device",
        expires_in: 60,
        interval: 1,
      }))
      .mockResolvedValueOnce(response({
        access_token: "access",
        token_type: "Bearer",
        scope: "urn:matrix:client:api:* urn:matrix:client:device:OTHER",
      }));
    vi.stubGlobal("fetch", fetchMock);
    const session = await startDeviceCodeLogin(OAUTH_METADATA, "client-id", "DEVICE123");
    await expect(waitForDeviceCodeLogin(OAUTH_METADATA, "client-id", session)).rejects.toThrow(
      "unexpected granted scope",
    );
  });

  it("rejects an oversized device session before polling", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForDeviceCodeLogin(OAUTH_METADATA, "client-id", {
        device_code: "device-code",
        user_code: "ABCD",
        verification_uri: "https://auth.example.test/device",
        expires_in: 20 * 60 + 1,
      },
      undefined,
      "DEVICE123",
      ),
    ).rejects.toThrow("OIDC device authorization failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a reconstructed device session without an expected device binding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForDeviceCodeLogin(OAUTH_METADATA, "client-id", {
        device_code: "device-code",
        user_code: "ABCD",
        verification_uri: "https://auth.example.test/device",
        expires_in: 60,
      }),
    ).rejects.toThrow("OIDC device authorization failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown device authorization error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: "provider_added_error" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      waitForDeviceCodeLogin(OAUTH_METADATA, "client-id", {
        device_code: "device-code",
        user_code: "ABCD",
        verification_uri: "https://auth.example.test/device",
        expires_in: 60,
        interval: 300,
      },
      undefined,
      "DEVICE123",
      ),
    ).resolves.toEqual({ error: "provider_error" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports cancelling device polling during its delay", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const fetchMock = vi.fn().mockResolvedValue(
        response({ error: "authorization_pending" }, 400),
      );
      vi.stubGlobal("fetch", fetchMock);
      const pending = waitForDeviceCodeLogin(
        OAUTH_METADATA,
        "client-id",
        {
          device_code: "device-code",
          user_code: "ABCD",
          verification_uri: "https://auth.example.test/device",
          expires_in: 60,
          interval: 30,
        },
        controller.signal,
        "DEVICE123",
      );
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await expect(pending).rejects.toThrow("OIDC device authorization cancelled");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes terminal device errors before returning them", async () => {
    const secret = "device-refresh-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          error: "access_denied",
          error_description: `refresh_token=${secret}`,
          error_uri: "https://auth.example.test/errors/access_denied",
          session_state: "must-not-be-returned",
          ignored_secret: "must-not-be-returned",
        }, 400),
      ),
    );

    const result = await waitForDeviceCodeLogin(OAUTH_METADATA, "client-id", {
      device_code: "device-code",
      user_code: "ABCD",
      verification_uri: "https://auth.example.test/device",
      expires_in: 60,
      interval: 1,
    }, undefined, "DEVICE123");

    expect(result).toEqual({ error: "access_denied" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
  });

  it("sanitizes homeserver identity errors", async () => {
    const secret = "whoami-access-secret";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          {
            error: `access_token=${secret};${"x".repeat(20_000)}`,
          },
          401,
        ),
      ),
    );

    let caught: unknown;
    try {
      await whoAmI("https://homeserver.example.test", "access-token");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("OIDC identity confirmation failed (401)");
    expect(message).toBe("OIDC identity confirmation failed (401)");
    expect(message).not.toContain(secret);
  });

  it("binds whoami identity to the requested homeserver and device grammar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ user_id: "@alice:other.example.test", device_id: "DEVICE123" }),
      ),
    );
    await expect(
      whoAmI("https://homeserver.example.test", "access-token"),
    ).rejects.toThrow("foreign user ID");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ user_id: "@alice:homeserver.example.test", device_id: "bad device" }),
      ),
    );
    await expect(
      whoAmI("https://homeserver.example.test", "access-token"),
    ).rejects.toThrow("invalid device ID");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ user_id: "@alice:homeserver.example.test", device_id: "DEVICE123" }),
      ),
    );
    await expect(
      whoAmI("https://homeserver.example.test", "access-token"),
    ).resolves.toEqual({ userId: "@alice:homeserver.example.test", deviceId: "DEVICE123" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ user_id: "@alice+storage:homeserver.example.test", device_id: "DEVICE123" }),
      ),
    );
    await expect(
      whoAmI("https://homeserver.example.test", "access-token"),
    ).resolves.toMatchObject({ userId: "@alice+storage:homeserver.example.test" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({ user_id: "@alice:homeserver.example.test", device_id: "DEVICE123" }),
      ),
    );
    await expect(
      whoAmI("https://homeserver.example.test:8448", "access-token"),
    ).rejects.toThrow("foreign user ID");
  });

  it("rejects a homeserver identity redirect without following it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response("", 302),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(whoAmI("https://homeserver.example.test", "access-token")).rejects.toThrow(
      "OIDC identity confirmation failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("preserves the Matrix HTTP caller signal while bounding identity confirmation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = whoAmI("https://homeserver.example.test", "access-token", controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await expect(pending).rejects.toThrow("OIDC identity confirmation cancelled");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending bounded identity response body", async () => {
    const controller = new AbortController();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const reader = {
      read: vi.fn(() => new Promise<never>(() => undefined)),
      cancel,
      releaseLock: vi.fn(),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      body: { getReader: () => reader },
      redirected: false,
      type: "basic",
      url: "https://homeserver.example.test/_matrix/client/v3/account/whoami",
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const pending = whoAmI("https://homeserver.example.test", "access-token", controller.signal);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toThrow("OIDC identity confirmation cancelled");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("maps TeleCrypt's registration contract to stable OAuth DCR", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ client_id: "client-id" }));
    vi.stubGlobal("fetch", fetchMock);

    await registerClient(OAUTH_METADATA, {
      clientName: "TeleCrypt test",
      clientUri: "https://telecrypt.io/",
      applicationType: "web",
      redirectUris: ["https://telecrypt.io/callback"],
      contacts: ["unused@example.test"],
    });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      client_name: "TeleCrypt test",
      client_uri: "https://telecrypt.io/",
      application_type: "web",
      redirect_uris: ["https://telecrypt.io/callback"],
      grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      token_endpoint_auth_method: "none",
    });
  });

  it("uses Matrix 42's stable device scope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        device_code: "device-code",
        user_code: "ABCD",
        verification_uri: "https://auth.example.test/device",
        expires_in: 600,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await startDeviceCodeLogin(OAUTH_METADATA, "client-id", "DEVICE123");

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = new URLSearchParams(String(request.body));
    expect(body.get("scope")).toBe("urn:matrix:client:api:* urn:matrix:client:device:DEVICE123");
  });
});
