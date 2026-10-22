import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "matrix-js-sdk";
import { encryptAttachment } from "matrix-encrypt-attachment";
import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture(mediaAfterRefresh?: () => Response) {
  const bytes = new TextEncoder().encode("private bytes");
  const encrypted = await encryptAttachment(bytes.buffer);
  const refresh = vi.fn(async () => ({
    accessToken: "fresh-token",
    refreshToken: "fresh-refresh",
    expiry: new Date(Date.now() + 300_000),
  }));
  const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("Authorization");
    if (auth !== "Bearer fresh-token") {
      return Response.json({ errcode: "M_UNKNOWN_TOKEN", error: "expired" }, { status: 401 });
    }
    if (String(input).endsWith("/account/whoami")) {
      return Response.json({ user_id: "@owner:example.test", device_id: "DEVICE" });
    }
    return mediaAfterRefresh?.() ?? new Response(encrypted.data);
  });
  const client = createClient({
    baseUrl: "https://matrix.example.test", userId: "@owner:example.test", deviceId: "DEVICE",
    accessToken: "expired-token", refreshToken: "usable-refresh", tokenRefreshFunction: refresh,
    fetchFn: transport,
  });
  const storage = new TeleCryptIOStorage(client);
  vi.spyOn(storage, "getOriginalFileEvent").mockResolvedValue({
    getContent: () => ({
      file: { ...encrypted.info, url: "mxc://example.test/private" },
      info: { size: bytes.byteLength, mimetype: "text/plain" },
    }),
  } as never);
  vi.stubGlobal("fetch", transport);
  return { storage, client, refresh, transport, bytes };
}

const branch = { id: "$file", roomId: "!vault:example.test" } as never;

describe("media session refresh", () => {
  it("uses the native refresh callback and downloads with the renewed token", async () => {
    const f = await fixture();
    const result = await f.storage.downloadFile(branch);
    expect(new Uint8Array(result.data)).toEqual(f.bytes);
    expect(result.mimetype).toBe("text/plain");
    expect(f.refresh).toHaveBeenCalledExactlyOnceWith("usable-refresh");
    expect(f.client.getAccessToken()).toBe("fresh-token");
    expect(f.transport).toHaveBeenCalledTimes(4);
  });

  it("does not loop when media still rejects the refreshed session", async () => {
    const f = await fixture(() => Response.json({ errcode: "M_UNKNOWN_TOKEN" }, { status: 401 }));
    await expect(f.storage.downloadFile(branch)).rejects.toThrow("media download failed");
    expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.transport).toHaveBeenCalledTimes(4);
  });

  it("keeps cross-origin redirect protection after refreshing", async () => {
    const f = await fixture(() => new Response(null, {
      status: 307, headers: { location: "https://attacker.example.test/file" },
    }));
    await expect(f.storage.downloadFile(branch)).rejects.toThrow("media download failed");
    expect(f.transport.mock.calls.every(([url]) => new URL(String(url)).origin === "https://matrix.example.test")).toBe(true);
    expect(f.transport).toHaveBeenCalledTimes(4);
  });

  it("settles cancellation while the shared refresh callback remains pending", async () => {
    const f = await fixture();
    f.refresh.mockImplementation(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = f.storage.downloadFile(branch, controller.signal);
    await vi.waitFor(() => expect(f.refresh).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow("operation cancelled");
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
});
