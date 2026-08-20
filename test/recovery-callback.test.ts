import { describe, expect, it, vi } from "vitest";
import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";

type RecoveryCallbackRunner = {
  withSecretStorageKey(
    privateKey: Uint8Array<ArrayBuffer>,
    fn: () => Promise<unknown>,
  ): Promise<unknown>;
};

describe("recovery callback wiring", () => {
  it("serializes temporary callback replacement per client", async () => {
    const originalGet = vi.fn();
    const originalCache = vi.fn();
    const client = {
      cryptoCallbacks: {
        getSecretStorageKey: originalGet,
        cacheSecretStorageKey: originalCache,
      },
    };
    const storage = new TeleCryptIOStorage(client as never) as unknown as RecoveryCallbackRunner;
    const otherStorage = new TeleCryptIOStorage(client as never) as unknown as RecoveryCallbackRunner;
    const firstKey = new Uint8Array(new ArrayBuffer(1));
    const secondKey = new Uint8Array(new ArrayBuffer(1));
    let releaseFirst!: () => void;
    let firstActive!: () => void;
    const firstIsActive = new Promise<void>((resolve) => {
      firstActive = resolve;
    });

    const first = storage.withSecretStorageKey(firstKey, async () => {
      firstActive();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return "first";
    });
    await firstIsActive;
    const callbacks = client.cryptoCallbacks;
    const firstCallback = callbacks.getSecretStorageKey;
    expect(firstCallback).not.toBe(originalGet);

    const second = otherStorage.withSecretStorageKey(secondKey, async () => {
      expect(callbacks.getSecretStorageKey).not.toBe(originalGet);
      const [, key] = await callbacks.getSecretStorageKey!({ keys: { key: {} } } as never);
      expect(key).toBe(secondKey);
      return "second";
    });

    expect(callbacks.getSecretStorageKey).toBe(firstCallback);
    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(callbacks.getSecretStorageKey).toBe(originalGet);
    expect(callbacks.cacheSecretStorageKey).toBe(originalCache);
  });
});
