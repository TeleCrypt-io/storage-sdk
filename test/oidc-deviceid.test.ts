// Verifies beginAuthorizationCodeFlow embeds a stable deviceId in the
// requested scope (MSC2967) so MAS grants that device instead of minting a
// fresh one per login.
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginAuthorizationCodeFlow } from "../src/core/oidc";

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
  token_endpoint: "https://mas.test/token",
  revocation_endpoint: "https://mas.test/revoke",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  jwks_uri: "https://mas.test/jwks",
  signingKeys: null,
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
      value: { sessionStorage: storage, localStorage: storage },
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
      homeserverUrl: "https://backend.test",
      redirectUri: "https://storage.test/",
      deviceId: "STABLE12345",
    });

    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("urn:matrix:org.matrix.msc2967.client:device:STABLE12345");
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
    expect(parsed.searchParams.get("redirect_uri")).toBe("https://storage.test/");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("falls back to matrix-js-sdk URL generation when no deviceId is given", async () => {
    const storage = new MemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { sessionStorage: storage, localStorage: storage },
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
    // matrix-js-sdk's generateOidcAuthorizationUrl performs discovery against
    // the authority; serve the metadata so it can build the URL.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/.well-known/openid-configuration") || url.includes("/.well-known/oauth-authorization-server")) {
          return new Response(
            JSON.stringify({
              issuer: METADATA.issuer,
              authorization_endpoint: METADATA.authorization_endpoint,
              token_endpoint: METADATA.token_endpoint,
              revocation_endpoint: METADATA.revocation_endpoint,
              response_types_supported: METADATA.response_types_supported,
              grant_types_supported: METADATA.grant_types_supported,
              code_challenge_methods_supported: METADATA.code_challenge_methods_supported,
              jwks_uri: METADATA.jwks_uri,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/jwks")) {
          return new Response(JSON.stringify({ keys: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const url = await beginAuthorizationCodeFlow({
      authMetadata: METADATA,
      clientId: "test-client",
      homeserverUrl: "https://backend.test",
      redirectUri: "https://storage.test/",
    });

    const parsed = new URL(url);
    const scope = parsed.searchParams.get("scope") ?? "";
    expect(scope).toContain("urn:matrix:org.matrix.msc2967.client:device:");
    expect(parsed.searchParams.get("client_id")).toBe("test-client");
  });
});
