import { describe, expect, it, vi } from "vitest";
import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import {
  RecoveryAlreadyConfiguredError,
  RecoveryRestoreError,
  RecoverySetupAmbiguousError,
  RecoverySetupError,
} from "../src/core/errors.js";

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

describe("bootstrap and recovery safety", () => {
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

  it("stops a client when startClient rejects after startup begins", async () => {
    const client = {
      initRustCrypto: vi.fn().mockResolvedValue(undefined),
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
    {
      label: "secret storage",
      status: { defaultKeyId: "key", ready: true },
      backupVersion: null,
    },
    {
      label: "key backup",
      status: { defaultKeyId: null, ready: false },
      backupVersion: "backup-version",
    },
  ])("refuses to replace existing $label state", async ({ status, backupVersion }) => {
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue(status),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(backupVersion),
      disableKeyStorage: vi.fn(),
      bootstrapCrossSigning: vi.fn(),
      createRecoveryKeyFromPassphrase: vi.fn(),
    };
    const client = {
      getCrypto: () => crypto,
      cryptoCallbacks: {},
    };
    const storage = new TeleCryptIOStorage(client as never);

    await expect(storage.keys.setupRecovery()).rejects.toBeInstanceOf(
      RecoveryAlreadyConfiguredError,
    );
    expect(crypto.disableKeyStorage).not.toHaveBeenCalled();
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
  });

  it("fails closed when the initial recovery status probe is ambiguous", async () => {
    const crypto = {
      getSecretStorageStatus: vi.fn().mockRejectedValue(new Error("status transport failed")),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
      bootstrapCrossSigning: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);

    await expect(storage.keys.setupRecovery()).rejects.toBeInstanceOf(RecoverySetupAmbiguousError);
    expect(crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
  });

  it("reports remote cross-signing keys without local private keys as partial", async () => {
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: null, ready: false }),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
      getCrossSigningStatus: vi.fn().mockResolvedValue({
        publicKeysOnDevice: true,
        privateKeysCachedLocally: { masterKey: false, selfSigningKey: false, userSigningKey: false },
        privateKeysInSecretStorage: false,
      }),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);

    await expect(storage.keys.getStatus()).resolves.toEqual({
      state: "partial",
      crossSigning: {
        publicKeysOnDevice: true,
        privateKeysCachedLocally: false,
        privateKeysInSecretStorage: false,
      },
      secretStorage: { ready: false, defaultKeyId: null },
      backupVersion: null,
    });
  });

  it.each([
    { label: "empty secret-storage status", status: {} },
    { label: "empty backup version", status: { defaultKeyId: null, ready: false }, backup: "" },
  ])("fails closed on a malformed $label", async ({ status, backup }) => {
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue(status),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(backup ?? null),
      getCrossSigningStatus: vi.fn().mockResolvedValue({
        publicKeysOnDevice: false,
        privateKeysCachedLocally: { masterKey: false, selfSigningKey: false, userSigningKey: false },
        privateKeysInSecretStorage: false,
      }),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto } as never);
    await expect(storage.keys.getStatus()).rejects.toBeInstanceOf(RecoverySetupAmbiguousError);
  });

  it("serializes setup and restore on one recovery queue", async () => {
    let configured = false;
    let activeBackupVersion: string | null = null;
    let releaseStatus!: () => void;
    const statusReady = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const crypto = {
      getSecretStorageStatus: vi.fn(async () => {
        await statusReady;
        return configured
          ? { defaultKeyId: "key", ready: true }
          : { defaultKeyId: null, ready: false };
      }),
      getActiveSessionBackupVersion: vi.fn(async () => activeBackupVersion),
      bootstrapCrossSigning: vi.fn().mockResolvedValue(undefined),
      createRecoveryKeyFromPassphrase: vi.fn().mockResolvedValue({
        privateKey: new Uint8Array(32),
        encodedPrivateKey: "recovery-key",
      }),
      bootstrapSecretStorage: vi.fn().mockImplementation(async (opts: {
        createSecretStorageKey: () => Promise<unknown>;
        setupNewKeyBackup?: boolean;
      }) => {
        expect(opts.setupNewKeyBackup).toBe(true);
        await opts.createSecretStorageKey();
        configured = true;
        activeBackupVersion = "backup";
      }),
      checkKeyBackupAndEnable: vi.fn().mockResolvedValue(undefined),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(),
      restoreKeyBackup: vi.fn(),
    };
    const client = { getCrypto: () => crypto, cryptoCallbacks: {} };
    const storage = new TeleCryptIOStorage(client as never);
    const setup = storage.keys.setupRecovery();
    let statusSettled = false;
    const status = storage.keys.isRecoverySetup().finally(() => {
      statusSettled = true;
    });
    let restoreSettled = false;
    const restore = storage.keys.restoreFromRecoveryKey("not-valid").finally(() => {
      restoreSettled = true;
    });

    await Promise.resolve();
    expect(statusSettled).toBe(false);
    expect(restoreSettled).toBe(false);
    releaseStatus();
    await expect(setup).resolves.toEqual({ recoveryKey: "recovery-key" });
    await expect(crypto.getActiveSessionBackupVersion()).resolves.toBe("backup");
    await expect(status).resolves.toBe(true);
    await expect(restore).rejects.toBeInstanceOf(RecoveryRestoreError);
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).not.toHaveBeenCalled();
    expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent recovery callbacks isolated across two clients", async () => {
    function client(label: string) {
      let configured = false;
      const originalGet = vi.fn().mockResolvedValue([`${label}-original`, new Uint8Array(32)]);
      const originalCache = vi.fn();
      const callbacks = {
        getSecretStorageKey: originalGet,
        cacheSecretStorageKey: originalCache,
      };
      const crypto = {
        getSecretStorageStatus: vi.fn().mockImplementation(async () =>
          configured ? { defaultKeyId: `${label}-key`, ready: true } : { defaultKeyId: null, ready: false }),
        getActiveSessionBackupVersion: vi.fn().mockImplementation(async () => configured ? `${label}-backup` : null),
        getCrossSigningStatus: vi.fn().mockResolvedValue({
          publicKeysOnDevice: false,
          privateKeysCachedLocally: { masterKey: false, selfSigningKey: false, userSigningKey: false },
          privateKeysInSecretStorage: false,
        }),
        bootstrapCrossSigning: vi.fn().mockResolvedValue(undefined),
        createRecoveryKeyFromPassphrase: vi.fn().mockResolvedValue({
          privateKey: new Uint8Array(label === "A" ? 32 : 33),
          encodedPrivateKey: `${label}-recovery-key`,
        }),
        bootstrapSecretStorage: vi.fn().mockImplementation(async (opts: {
          createSecretStorageKey: () => Promise<{ privateKey: Uint8Array }>;
        }) => {
          const [keyId, privateKey] = await callbacks.getSecretStorageKey({ keys: { [`${label}-key`]: {} } });
          expect(keyId).toBe(`${label}-key`);
          expect(privateKey.byteLength).toBe(label === "A" ? 32 : 33);
          await opts.createSecretStorageKey();
          configured = true;
        }),
        checkKeyBackupAndEnable: vi.fn().mockResolvedValue(undefined),
      };
      return {
        storage: new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: callbacks } as never),
        crypto,
        callbacks,
        originalGet,
        originalCache,
      };
    }

    const first = client("A");
    const second = client("B");
    const [firstResult, secondResult] = await Promise.all([
      first.storage.keys.setupRecovery(),
      second.storage.keys.setupRecovery(),
    ]);

    expect(firstResult.recoveryKey).toBe("A-recovery-key");
    expect(secondResult.recoveryKey).toBe("B-recovery-key");
    expect(first.callbacks.getSecretStorageKey).toBe(first.originalGet);
    expect(first.callbacks.cacheSecretStorageKey).toBe(first.originalCache);
    expect(second.callbacks.getSecretStorageKey).toBe(second.originalGet);
    expect(second.callbacks.cacheSecretStorageKey).toBe(second.originalCache);
  });

  it("does not retry when bootstrap may have committed without a usable callback", async () => {
    const crypto = {
      getSecretStorageStatus: vi
        .fn()
        .mockResolvedValueOnce({ defaultKeyId: null, ready: false })
        .mockResolvedValueOnce({ defaultKeyId: "key", ready: true }),
      getActiveSessionBackupVersion: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce("backup"),
      bootstrapCrossSigning: vi.fn().mockResolvedValue(undefined),
      createRecoveryKeyFromPassphrase: vi.fn().mockResolvedValue({
        privateKey: new Uint8Array(32),
        encodedPrivateKey: "recovery-key",
      }),
      bootstrapSecretStorage: vi.fn().mockResolvedValue(undefined),
      checkKeyBackupAndEnable: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);
    await expect(storage.keys.setupRecovery()).rejects.toBeInstanceOf(RecoverySetupAmbiguousError);
    expect(crypto.bootstrapSecretStorage).toHaveBeenCalledTimes(1);
    expect(crypto.bootstrapSecretStorage.mock.calls[0][0]).not.toHaveProperty("setupNewSecretStorage");
    expect(crypto.bootstrapSecretStorage.mock.calls[0][0]).toHaveProperty("setupNewKeyBackup", true);
  });

  it("treats malformed post-failure recovery status as ambiguous", async () => {
    const crypto = {
      getSecretStorageStatus: vi
        .fn()
        .mockResolvedValueOnce({ defaultKeyId: null, ready: false })
        .mockResolvedValueOnce({}),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
      bootstrapCrossSigning: vi.fn().mockResolvedValue(undefined),
      createRecoveryKeyFromPassphrase: vi.fn().mockResolvedValue({
        privateKey: new Uint8Array(32),
        encodedPrivateKey: "recovery-key",
      }),
      bootstrapSecretStorage: vi.fn().mockRejectedValue(new Error("transport failed")),
      checkKeyBackupAndEnable: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);

    await expect(storage.keys.setupRecovery()).rejects.toBeInstanceOf(RecoverySetupAmbiguousError);
  });

  it("does not cross a recovery mutation boundary after caller cancellation", async () => {
    const controller = new AbortController();
    let releaseCrossSigning!: () => void;
    const crossSigning = new Promise<void>((resolve) => {
      releaseCrossSigning = resolve;
    });
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: null, ready: false }),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
      bootstrapCrossSigning: vi.fn().mockReturnValue(crossSigning),
      createRecoveryKeyFromPassphrase: vi.fn(),
      bootstrapSecretStorage: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);
    const setup = storage.keys.setupRecovery(controller.signal);
    await vi.waitFor(() => expect(crypto.bootstrapCrossSigning).toHaveBeenCalledTimes(1));
    controller.abort();
    releaseCrossSigning();

    await expect(setup).rejects.toBeInstanceOf(RecoverySetupAmbiguousError);
    expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it("bounds a CryptoApi call that ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const crypto = {
        getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: null, ready: false }),
        getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
        bootstrapCrossSigning: vi.fn().mockReturnValue(new Promise<void>(() => undefined)),
        createRecoveryKeyFromPassphrase: vi.fn(),
      };
      const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);
      const pending = storage.keys.setupRecovery();
      const assertion = expect(pending).rejects.toBeInstanceOf(RecoverySetupAmbiguousError);
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;
      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the actual Matrix 42 cross-signing status shape", async () => {
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: null, ready: false }),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
      getCrossSigningStatus: vi.fn().mockResolvedValue({
        publicKeysOnDevice: true,
        privateKeysCachedLocally: { masterKey: true, selfSigningKey: true, userSigningKey: true },
        privateKeysInSecretStorage: false,
      }),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);
    await expect(storage.keys.getStatus()).resolves.toMatchObject({
      state: "partial",
      crossSigning: {
        publicKeysOnDevice: true,
        privateKeysCachedLocally: true,
        privateKeysInSecretStorage: false,
      },
    });
  });

  it("fails closed when secret storage requests multiple keys during setup", async () => {
    const callbacks: { getSecretStorageKey?: (opts: { keys: Record<string, unknown> }) => Promise<unknown> } = {};
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: null, ready: false }),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
      bootstrapCrossSigning: vi.fn().mockResolvedValue(undefined),
      createRecoveryKeyFromPassphrase: vi.fn().mockResolvedValue({
        privateKey: new Uint8Array(32),
        encodedPrivateKey: "recovery-key",
      }),
      bootstrapSecretStorage: vi.fn().mockImplementation(async (_opts: {
        createSecretStorageKey: () => Promise<unknown>;
      }) => {
        const answer = await callbacks.getSecretStorageKey?.({ keys: { first: {}, second: {} } });
        if (answer !== null) throw new Error("ambiguous secret-storage key request was accepted");
        throw new Error("secret-storage provider rejected an ambiguous key request");
      }),
      checkKeyBackupAndEnable: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: callbacks } as never);
    await expect(storage.keys.setupRecovery()).rejects.toBeInstanceOf(RecoverySetupError);
  });

  it("uses the validated default key when secret storage requests multiple keys", async () => {
    const callbacks: { getSecretStorageKey?: (opts: { keys: Record<string, unknown> }) => Promise<unknown> } = {};
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: "default", ready: true }),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn().mockImplementation(async () => {
        const result = await callbacks.getSecretStorageKey?.({ keys: { other: {}, default: {} } });
        expect(result).toEqual(["default", expect.any(Uint8Array)]);
      }),
      restoreKeyBackup: vi.fn().mockResolvedValue({ imported: 1, total: 1 }),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: callbacks } as never);
    const recoveryKey = encodeRecoveryKey(new Uint8Array(32));
    await expect(storage.keys.restoreFromRecoveryKey(recoveryKey!)).resolves.toEqual({ imported: 1, total: 1 });
  });

  it("rejects a secret-storage request that omits the validated default key", async () => {
    const callbacks: { getSecretStorageKey?: (opts: { keys: Record<string, unknown> }) => Promise<unknown> } = {};
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: "default", ready: true }),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn().mockImplementation(async () => {
        const result = await callbacks.getSecretStorageKey?.({ keys: { other: {}, another: {} } });
        if (result === null) throw new Error("secret-storage key is unavailable");
      }),
      restoreKeyBackup: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: callbacks } as never);
    const recoveryKey = encodeRecoveryKey(new Uint8Array(32));
    await expect(storage.keys.restoreFromRecoveryKey(recoveryKey!)).rejects.toBeInstanceOf(
      RecoveryRestoreError,
    );
    expect(crypto.restoreKeyBackup).not.toHaveBeenCalled();
  });

  it("checks cancellation inside the one-time recovery-key callback", async () => {
    const controller = new AbortController();
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: null, ready: false }),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue(null),
      bootstrapCrossSigning: vi.fn().mockResolvedValue(undefined),
      createRecoveryKeyFromPassphrase: vi.fn().mockResolvedValue({
        privateKey: new Uint8Array(32),
        encodedPrivateKey: "recovery-key",
      }),
      bootstrapSecretStorage: vi.fn().mockImplementation(async (opts: {
        createSecretStorageKey: () => Promise<unknown>;
      }) => {
        controller.abort();
        await opts.createSecretStorageKey();
      }),
      checkKeyBackupAndEnable: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);

    await expect(storage.keys.setupRecovery(controller.signal)).rejects.toBeInstanceOf(
      RecoverySetupAmbiguousError,
    );
    expect(crypto.checkKeyBackupAndEnable).not.toHaveBeenCalled();
  });

  it("rejects oversized recovery-key input before passing it to crypto", async () => {
    const crypto = {
      getSecretStorageStatus: vi.fn().mockResolvedValue({ defaultKeyId: "key", ready: true }),
      getActiveSessionBackupVersion: vi.fn().mockResolvedValue("backup"),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(),
    };
    const storage = new TeleCryptIOStorage({ getCrypto: () => crypto, cryptoCallbacks: {} } as never);
    await expect(storage.keys.restoreFromRecoveryKey("A".repeat(257))).rejects.toBeInstanceOf(
      RecoveryRestoreError,
    );
    expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).not.toHaveBeenCalled();
  });
});
