import { describe, expect, it, vi } from "vitest";
import { SyncState } from "matrix-js-sdk";
import { OnlySignedDevicesIsolationMode } from "matrix-js-sdk/lib/crypto-api/index.js";
import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";
const bootstrap = (TeleCryptIOStorage as unknown as {
  bootstrap: (client: unknown, opts: Record<string, unknown>) => Promise<TeleCryptIOStorage>;
}).bootstrap;

function bootstrapOptions(): Record<string, unknown> {
  return {
    userId: "@alice:example.test",
    deviceId: "DEVICE",
    persistentCryptoStore: false,
    initTimeoutMs: 100,
    syncTimeoutMs: 5,
  };
}

describe("crypto bootstrap", () => {
  it("clears the bootstrap timeout timer after the operation settles", async () => {
    vi.useFakeTimers();
    try {
      const withTimeout = (TeleCryptIOStorage as unknown as {
        withTimeout: <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;
      }).withTimeout;
      await expect(withTimeout(Promise.resolve("ready"), 100, "init")).resolves.toBe("ready");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a client when crypto initialization rejects", async () => {
    const client = {
      initRustCrypto: vi.fn().mockRejectedValue(new Error("crypto init failed")),
      stopClient: vi.fn(),
    };

    await expect(bootstrap(client, bootstrapOptions())).rejects.toThrow("crypto init failed");
    expect(client.stopClient).toHaveBeenCalledTimes(1);
  });

  it("can initialize crypto before starting room sync", async () => {
    const checkKeyBackupAndEnable = vi.fn().mockResolvedValue(null);
    const setDeviceIsolationMode = vi.fn();
    const client = {
      initRustCrypto: vi.fn().mockResolvedValue(undefined),
      startClient: vi.fn().mockResolvedValue(undefined),
      getSyncState: vi.fn().mockReturnValue(SyncState.Prepared),
      getCrypto: () => ({ checkKeyBackupAndEnable, setDeviceIsolationMode }),
      stopClient: vi.fn(),
    };

    const storage = await bootstrap(client, { ...bootstrapOptions(), startClient: false });
    expect(client.startClient).not.toHaveBeenCalled();
    expect(setDeviceIsolationMode).toHaveBeenCalledWith(expect.any(OnlySignedDevicesIsolationMode));
    expect(checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);

    await storage.startSync();
    await storage.startSync();
    expect(client.startClient).toHaveBeenCalledTimes(1);
    expect(client.startClient).toHaveBeenCalledWith({ initialSyncLimit: 10 });
    expect(setDeviceIsolationMode.mock.invocationCallOrder[0]).toBeLessThan(client.startClient.mock.invocationCallOrder[0]!);
  });

  it("stops a client when startClient rejects after startup begins", async () => {
    const client = {
      initRustCrypto: vi.fn().mockResolvedValue(undefined),
      getCrypto: () => ({ setDeviceIsolationMode: vi.fn() }),
      startClient: vi.fn().mockRejectedValue(new Error("initial sync failed")),
      stopClient: vi.fn(),
    };

    await expect(bootstrap(client, bootstrapOptions())).rejects.toThrow("initial sync failed");
    expect(client.stopClient).toHaveBeenCalledTimes(1);
  });

  it("times out startClient and stops it before bootstrap can continue", async () => {
    vi.useFakeTimers();
    try {
      const client = {
        initRustCrypto: vi.fn().mockResolvedValue(undefined),
        getCrypto: () => ({ setDeviceIsolationMode: vi.fn() }),
        startClient: vi.fn().mockReturnValue(new Promise<void>(() => {})),
        stopClient: vi.fn(),
      };
      const pending = bootstrap(client, bootstrapOptions());
      const assertion = expect(pending).rejects.toThrow("client start timeout");
      await vi.advanceTimersByTimeAsync(5);
      await assertion;
      expect(client.stopClient).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending start and stops the owned client", async () => {
    const controller = new AbortController();
    const client = {
      initRustCrypto: vi.fn().mockResolvedValue(undefined),
      getCrypto: () => ({ setDeviceIsolationMode: vi.fn() }),
      startClient: vi.fn().mockReturnValue(new Promise<void>(() => {})),
      stopClient: vi.fn(),
    };
    const pending = bootstrap(client, { ...bootstrapOptions(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("storage bootstrap cancelled");
    expect(client.stopClient).toHaveBeenCalledTimes(1);
  });

  it("stops a client when first-sync waiting times out", async () => {
    const client = {
      initRustCrypto: vi.fn().mockResolvedValue(undefined),
      getCrypto: () => ({ setDeviceIsolationMode: vi.fn() }),
      startClient: vi.fn().mockResolvedValue(undefined),
      getSyncState: vi.fn().mockReturnValue(null),
      on: vi.fn(),
      removeListener: vi.fn(),
      stopClient: vi.fn(),
    };

    await expect(bootstrap(client, bootstrapOptions())).rejects.toThrow("sync timeout");
    expect(client.stopClient).toHaveBeenCalledTimes(1);
    expect(client.removeListener).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["default", { other: {}, default: {} }, "default"],
    ["default", { other: {} }, null],
    [null, { first: {}, second: {} }, null],
    [null, { first: {} }, "first"],
  ])("supplies the Safe key only to the selected secret-storage slot (%s)", async (defaultKeyId, keys, expected) => {
    const previous = vi.fn();
    const callbacks = { getSecretStorageKey: previous, cacheSecretStorageKey: vi.fn() };
    const client = {
      getCrypto: () => ({ getSecretStorageStatus: async () => ({ defaultKeyId, ready: defaultKeyId !== null }) }),
      cryptoCallbacks: callbacks,
    };
    const storage = new TeleCryptIOStorage(client as never) as unknown as {
      withSecretStorageKey: <T>(key: Uint8Array, operation: () => Promise<T>) => Promise<T>;
    };
    const key = new Uint8Array(32).fill(7);
    await expect(storage.withSecretStorageKey(key, async () => {
      expect(await callbacks.getSecretStorageKey({ keys })).toEqual(expected ? [expected, key] : null);
      throw new Error("native operation failed");
    })).rejects.toThrow("native operation failed");
    expect(callbacks.getSecretStorageKey).toBe(previous);
  });

});
