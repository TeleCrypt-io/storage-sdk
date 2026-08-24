// Verifies beginAuthorizationCodeFlow embeds a stable deviceId in Matrix's
// stable OAuth scope so MAS grants that device instead of minting a fresh one.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAuthorizationCodeFlow,
  completeAuthorizationCodeFlow,
  extractDeviceIdFromScope,
} from "../src/core/oidc";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const METADATA = {
  issuer: "https://mas.test",
  authorization_endpoint: "https://mas.test/authorize",
  registration_endpoint: "https://mas.test/register",
  token_endpoint: "https://mas.test/token",
  revocation_endpoint: "https://mas.test/revoke",
  response_modes_supported: ["query", "fragment"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("beginAuthorizationCodeFlow deviceId", () => {
  it("embeds the stable deviceId in the requested scope", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { sessionStorage: storage, localStorage: storage, location: { origin: "https://storage.test" } },
    });
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-nonce-1234",
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
        return arr;
      },
      subtle: {
        digest: async () => new Uint8Array(32).fill(7),
      },
    });

    const url = await beginAuthorizationCodeFlow({
      authMetadata: METADATA,
      clientId: "test-client",
      homeserverUrl: "https://mas.test",
      redirectUri: "https://storage.test/",
      deviceId: "STABLE12345",
    });

    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("urn:matrix:client:device:STABLE12345");
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://storage.test/");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("generates a stable Matrix OAuth scope when no deviceId is given", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { sessionStorage: storage, localStorage: storage, location: { origin: "https://storage.test" } },
    });
    vi.stubGlobal("crypto", {
      randomUUID: () => "test-nonce-5678",
      getRandomValues: (arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = i % 256;
        return arr;
      },
      subtle: {
        digest: async () => new Uint8Array(32).fill(9),
      },
    });
    const url = await beginAuthorizationCodeFlow({
      authMetadata: METADATA,
      clientId: "test-client",
      homeserverUrl: "https://mas.test",
      redirectUri: "https://storage.test/",
    });

    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("urn:matrix:client:device:");
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
  });
});

describe("extractDeviceIdFromScope", () => {
  it("extracts device IDs from the stable Matrix scope", () => {
    const scope = "urn:matrix:client:api:* urn:matrix:client:device:STABLE12345";
    const expected = "STABLE12345";
    expect(extractDeviceIdFromScope(scope)).toBe(expected);
  });

  it("rejects a scope without a device grant", () => {
    expect(extractDeviceIdFromScope("openid urn:matrix:client:api:*")).toBeNull();
  });

  it("rejects duplicate or substring device grants", () => {
    expect(
      extractDeviceIdFromScope(
        "urn:matrix:client:device:ONE urn:matrix:client:device:TWO",
      ),
    ).toBeNull();
    expect(extractDeviceIdFromScope("urn:matrix:client:device:ONE:extra")).toBeNull();
  });
});

async function beginForCallback(storage: MemoryStorage): Promise<{ state: string; key: string }> {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { sessionStorage: storage, localStorage: storage, location: { origin: "https://storage.test" } },
  });
  vi.stubGlobal("crypto", {
    randomUUID: () => "unused",
    getRandomValues: (arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = (i + 1) % 256;
      return arr;
    },
    subtle: { digest: async () => new Uint8Array(32).fill(7) },
  });
  const url = await beginAuthorizationCodeFlow({
    authMetadata: METADATA,
    clientId: "test-client",
    homeserverUrl: "https://mas.test",
    redirectUri: "https://storage.test/",
    deviceId: "CALLBACK123",
  });
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("test authorization URL did not contain state");
  const key = storage.key(0);
  if (!key) throw new Error("test authorization context was not stored");
  return { state, key };
}

describe("authorization context replay and tamper protection", () => {
  it("consumes a valid context before exchange and rejects replay", async () => {
    const storage = new MemoryStorage();
    const { state } = await beginForCallback(storage);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token_type: "Bearer",
          access_token: "access-token",
          refresh_token: "refresh-token",
          scope: "urn:matrix:client:api:* urn:matrix:client:device:CALLBACK123",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).resolves.toMatchObject({
      homeserverUrl: "https://mas.test/",
      oidcClientSettings: { clientId: "test-client", issuer: "https://mas.test" },
    });
    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      /missing or expired/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds an oversized authorization-code exchange response", async () => {
    const storage = new MemoryStorage();
    const { state } = await beginForCallback(storage);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token_type: "Bearer",
          access_token: "access-token",
          padding: "x".repeat(40_000),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      "OIDC authorization code exchange returned an oversized response",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("deletes and rejects a tampered context before any token request", async () => {
    const storage = new MemoryStorage();
    const { state, key } = await beginForCallback(storage);
    const context = JSON.parse(storage.getItem(key)!);
    context.redirectUri = "https://evil.test/callback";
    storage.setItem(key, JSON.stringify(context));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(/origins/);
    expect(storage.getItem(key)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns malformed stored JSON into a stable storage error before exchange", async () => {
    const storage = new MemoryStorage();
    const { state, key } = await beginForCallback(storage);
    storage.setItem(key, "{not valid json");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      "OIDC authorization context is missing or invalid",
    );
    expect(storage.getItem(key)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a context moved to a different callback state", async () => {
    const storage = new MemoryStorage();
    const { state, key } = await beginForCallback(storage);
    const context = JSON.parse(storage.getItem(key)!);
    const movedState = "b".repeat(64);
    context.state = movedState;
    storage.setItem(key, JSON.stringify(context));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      /state does not match/,
    );
    expect(storage.getItem(key)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes the context when the callback has no authorization code", async () => {
    const storage = new MemoryStorage();
    const { state } = await beginForCallback(storage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("", state)).rejects.toThrow(/authorization code/);
    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      /missing or expired/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects metadata tampering before any token request", async () => {
    const storage = new MemoryStorage();
    const { state, key } = await beginForCallback(storage);
    const context = JSON.parse(storage.getItem(key)!);
    context.authMetadata.token_endpoint = "https://evil.test/token";
    storage.setItem(key, JSON.stringify(context));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      /invalid token endpoint/,
    );
    expect(storage.getItem(key)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("consumes an expired authorization context before any token request", async () => {
    const storage = new MemoryStorage();
    const { state, key } = await beginForCallback(storage);
    const context = JSON.parse(storage.getItem(key)!);
    context.createdAtMs = Date.now() - 10 * 60 * 1000 - 1;
    storage.setItem(key, JSON.stringify(context));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      /authorization context is expired/,
    );
    expect(storage.getItem(key)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a context with a materially future creation time", async () => {
    const storage = new MemoryStorage();
    const { state, key } = await beginForCallback(storage);
    const context = JSON.parse(storage.getItem(key)!);
    // Leave enough margin for the callback setup and assertion scheduling;
    // using only one millisecond over the skew boundary makes this test
    // depend on how quickly the test runner reaches the callback.
    context.createdAtMs = Date.now() + 60 * 1000;
    storage.setItem(key, JSON.stringify(context));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      /authorization context is from the future/,
    );
    expect(storage.getItem(key)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed client binding before any token request", async () => {
    const storage = new MemoryStorage();
    const { state, key } = await beginForCallback(storage);
    const context = JSON.parse(storage.getItem(key)!);
    context.clientId = "client id with spaces";
    storage.setItem(key, JSON.stringify(context));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(completeAuthorizationCodeFlow("authorization-code", state)).rejects.toThrow(
      /invalid client ID/,
    );
    expect(storage.getItem(key)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the callback state has no stored context", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { sessionStorage: storage, localStorage: storage, location: { origin: "https://storage.test" } },
    });

    await expect(completeAuthorizationCodeFlow("authorization-code", "a".repeat(32))).rejects.toThrow(
      /missing or expired/,
    );
  });
});
