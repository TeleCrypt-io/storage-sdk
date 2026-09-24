import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { MatrixError } from "matrix-js-sdk";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import { DecryptionKeySafe } from "../src/key-safe.js";
import { listVaults } from "../src/core/operations.js";

function fixture() {
  const key = new Uint8Array(32).fill(7);
  const encoded = encodeRecoveryKey(key);
  let keyId: string | null = null;
  let backup: { version: string } | null = null;
  let locallySigned = false;
  let signingCached = false;
  let signingStored = false;
  let active: string | null = null;
  let published = false;
  const serverAccountData = new Map<string, Record<string, unknown>>();
  const cachedAccountData = new Map<string, Record<string, unknown> | null>();
  const setAccountData = (type: string, content: Record<string, unknown>) => {
    serverAccountData.set(type, content);
    cachedAccountData.set(type, content);
  };
  const signing = {
    master_key: { keys: { "ed25519:master": "master" } },
    self_signing_key: { keys: { "ed25519:self": "self" } },
    user_signing_key: { keys: { "ed25519:user": "user" } },
  };
  const crypto = {
    createRecoveryKeyFromPassphrase: vi.fn(async () => ({ privateKey: key, encodedPrivateKey: encoded })),
    getKeyBackupInfo: vi.fn(async () => backup),
    getActiveSessionBackupVersion: vi.fn(async () => active),
    getCrossSigningStatus: vi.fn(async () => ({
      privateKeysInSecretStorage: signingStored,
      privateKeysCachedLocally: { masterKey: signingCached, selfSigningKey: signingCached, userSigningKey: signingCached },
    })),
    bootstrapCrossSigning: vi.fn(async () => { signingCached = true; }),
    getUserCrossSigningKeys: vi.fn(async () => signingCached ? signing : null),
    crossSignDevice: vi.fn(async () => { locallySigned = true; }),
    userHasCrossSigningKeys: vi.fn(async () => published),
    getUserVerificationStatus: vi.fn(async () => ({ isVerified: () => signingCached && published })),
    getDeviceVerificationStatus: vi.fn(async () => ({ signedByOwner: locallySigned })),
    isCrossSigningReady: vi.fn(async () => signingCached && published),
    bootstrapSecretStorage: vi.fn(async (opts) => {
      if (!keyId) {
        await opts.createSecretStorageKey(); keyId = "safe-key";
        setAccountData("m.secret_storage.key.safe-key", { algorithm: "m.secret_storage.v1.aes-hmac-sha2" });
        setAccountData("m.secret_storage.default_key", { key: "safe-key" });
      }
      signingStored = true;
      for (const name of ["m.cross_signing.master", "m.cross_signing.self_signing", "m.cross_signing.user_signing", "m.megolm_backup.v1"]) {
        setAccountData(name, { encrypted: { "safe-key": { iv: "iv", ciphertext: "ciphertext", mac: "mac" } } });
      }
      if (opts.setupNewKeyBackup) backup = { version: String(Number(backup?.version ?? 0) + 1) };
    }),
    loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => undefined),
    checkKeyBackupAndEnable: vi.fn(async () => { active = backup?.version ?? null; }),
    restoreKeyBackup: vi.fn(async () => ({ imported: 0, total: 0 })),
  };
  const client = {
    getUserId: () => "@owner:test", getDeviceId: () => "DEVICE",
    getCrypto: () => crypto,
    secretStorage: {
      getKey: vi.fn(async () => {
        const id = cachedAccountData.get("m.secret_storage.default_key")?.key;
        if (typeof id !== "string") return null;
        const info = cachedAccountData.get(`m.secret_storage.key.${id}`);
        return info ? [id, info] : null;
      }),
      checkKey: vi.fn(async (given: Uint8Array) => given.every((byte, i) => byte === key[i])),
    },
    store: { storeAccountDataEvents: vi.fn((events: Array<{ getType: () => string; getContent: () => Record<string, unknown> | null }>) => {
      for (const event of events) cachedAccountData.set(event.getType(), event.getContent());
    }) },
    downloadKeysForUsers: vi.fn(async () => published ? {
      master_keys: { "@owner:test": signing.master_key },
      self_signing_keys: { "@owner:test": signing.self_signing_key },
      user_signing_keys: { "@owner:test": signing.user_signing_key },
    } : {}),
    http: { authedRequest: vi.fn(async (method: string, path?: string) => {
      if (method === "GET" && path?.includes("/account_data/")) {
        const type = decodeURIComponent(path.slice(path.indexOf("/account_data/") + "/account_data/".length));
        const content = serverAccountData.get(type);
        if (!content) throw new MatrixError({ errcode: "M_NOT_FOUND" }, 404);
        return content;
      }
      if (method === "GET") {
        if (!backup) throw new MatrixError({ errcode: "M_NOT_FOUND" }, 404);
        return backup;
      }
      published = true; return {};
    }) },
  };
  const checkpoint = vi.fn(async () => undefined);
  const startSync = vi.fn(async () => undefined);
  const prefix = `telecrypt-io-storage::key-safe-test::${cryptoRandomId()}`;
  const make = () => new DecryptionKeySafe(client as never, async (_key, fn) => fn(), {
    cryptoDatabasePrefix: prefix, onKeySafeStateChanged: checkpoint,
  }, startSync);
  return { safe: make(), make, crypto, client, checkpoint, encoded, serverAccountData, cachedAccountData,
    startSync,
    newLogin: () => { signingCached = false; locallySigned = false; active = null; cachedAccountData.clear(); },
    removeBackup: () => { backup = null; active = null; },
  };
}
let fixtureId = 0;
function cryptoRandomId() { return String(++fixtureId); }

describe("mandatory Decryption Key Safe", () => {
  it("requires saved-key confirmation and preserves the same pending key across restarts", async () => {
    const f = fixture();
    expect(await f.safe.getStatus()).toEqual({ state: "setup-required" });
    expect(await f.safe.setup()).toEqual({ recoveryKey: f.encoded });
    await expect(f.safe.requireReady()).rejects.toThrow("Decryption Key Safe");
    const restarted = f.make();
    expect(await restarted.getStatus()).toEqual({ state: "confirmation-required", recoveryKey: f.encoded });
    expect(await restarted.setup()).toEqual({ recoveryKey: f.encoded });
    expect(f.crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledOnce();
    expect(f.crypto.bootstrapSecretStorage.mock.calls.filter(([opts]) => opts.setupNewKeyBackup)).toHaveLength(1);
    expect(await restarted.confirmSaved()).toEqual({ state: "ready" });
    expect(await f.make().getStatus()).toEqual({ state: "ready" });
    expect((await f.make().getStatus()).recoveryKey).toBeUndefined();
  });

  it("persists the pending key before any remote mutation and resumes a failed signing upload", async () => {
    const f = fixture();
    const original = f.client.http.authedRequest.getMockImplementation()!;
    let fail = true;
    f.client.http.authedRequest.mockImplementation(async (...args) => {
      const [method] = args;
      if (method !== "GET" && fail) {
        expect(f.checkpoint).toHaveBeenCalledOnce(); fail = false;
        throw new Error("connection lost");
      }
      return original(...args);
    });
    await expect(f.safe.setup()).rejects.toThrow("connection lost");
    expect(await f.make().getStatus()).toEqual({ state: "confirmation-required", recoveryKey: f.encoded });
    await f.make().setup();
    expect(f.serverAccountData.get("m.secret_storage.default_key")).toEqual({ key: "safe-key" });
    expect(f.cachedAccountData.get("m.secret_storage.default_key")).toEqual({ key: "safe-key" });
    expect(await f.client.secretStorage.getKey()).not.toBeNull();
    expect(f.serverAccountData.get("m.secret_storage.key.safe-key")).toBeDefined();
    await f.make().confirmSaved();
    expect(f.crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledOnce();
    expect(f.client.http.authedRequest).toHaveBeenCalled();
    expect(f.crypto.crossSignDevice).toHaveBeenCalledWith("DEVICE");
  });

  it("refuses to continue if local persistence fails", async () => {
    const f = fixture();
    f.checkpoint.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.safe.setup()).rejects.toThrow("disk full");
    expect(f.crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(f.client.http.authedRequest.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });

  it("restores account signatures and an empty backup without replacing the safe", async () => {
    const f = fixture();
    await f.safe.setup(); await f.safe.confirmSaved();
    f.newLogin();
    const fresh = f.make();
    expect(await fresh.getStatus()).toEqual({ state: "restore-required" });
    f.crypto.userHasCrossSigningKeys.mockClear();
    f.crypto.bootstrapCrossSigning.mockClear();
    f.crypto.restoreKeyBackup.mockClear();
    f.startSync.mockClear();
    expect(await fresh.restore(f.encoded)).toEqual({ imported: 0, total: 0, state: "ready" });
    expect(f.crypto.userHasCrossSigningKeys).toHaveBeenCalledWith("@owner:test", true);
    expect(f.crypto.userHasCrossSigningKeys.mock.invocationCallOrder[0]).toBeLessThan(f.crypto.bootstrapCrossSigning.mock.invocationCallOrder[0]);
    expect(f.startSync).toHaveBeenCalledOnce();
    expect(f.crypto.restoreKeyBackup.mock.invocationCallOrder[0]).toBeLessThan(f.startSync.mock.invocationCallOrder[0]);
    expect(await fresh.getStatus()).toEqual({ state: "ready" });
    expect(f.crypto.bootstrapSecretStorage.mock.calls.filter(([opts]) => opts.setupNewKeyBackup)).toHaveLength(1);
  });

  it("refreshes server key-safe records before the first readiness check on a fresh login", async () => {
    const f = fixture();
    await f.safe.setup(); await f.safe.confirmSaved();
    f.newLogin();
    const fresh = f.make();
    const requestsBeforeStatus = f.client.http.authedRequest.mock.calls.length;

    expect(await fresh.getStatus()).toEqual({ state: "restore-required" });
    expect(f.client.store.storeAccountDataEvents).toHaveBeenCalled();
    expect(f.client.http.authedRequest.mock.calls.slice(requestsBeforeStatus).filter(([, path]) => String(path).includes("/account_data/"))).toHaveLength(6);
  });

  it("uses server backup existence even when this login has no active local backup", async () => {
    const f = fixture();
    await f.safe.setup(); await f.safe.confirmSaved(); f.newLogin();
    await expect(f.safe.setup()).rejects.toThrow("already exists");
    expect(f.crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledOnce();
  });

  it("does not replace a server key reference whose key record is missing", async () => {
    const f = fixture();
    f.serverAccountData.set("m.secret_storage.default_key", { key: "missing-key-record" });

    expect(await f.safe.getStatus()).toEqual({ state: "restore-required" });
    await expect(f.safe.setup()).rejects.toThrow("already exists");
    expect(f.crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
  });

  it("rejects a wrong key without changing signing or backup", async () => {
    const f = fixture(); await f.safe.setup(); await f.safe.confirmSaved();
    f.crypto.bootstrapCrossSigning.mockClear(); f.crypto.bootstrapSecretStorage.mockClear();
    await expect(f.safe.restore(encodeRecoveryKey(new Uint8Array(32).fill(8)))).rejects.toThrow("does not unlock");
    expect(f.crypto.bootstrapCrossSigning).not.toHaveBeenCalled();
    expect(f.crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it("resumes missing backup creation under the already-created safe key", async () => {
    const f = fixture(); await f.safe.setup(); f.removeBackup();
    await expect(f.safe.restore(f.encoded)).resolves.toMatchObject({ state: "ready" });
    expect(f.crypto.createRecoveryKeyFromPassphrase).toHaveBeenCalledOnce();
  });

  it("blocks core storage access before confirmation without running the operation", async () => {
    const f = fixture(); const listTrees = vi.fn();
    await expect(listVaults({ keySafe: f.safe, listTrees } as never)).rejects.toThrow("Decryption Key Safe");
    expect(listTrees).not.toHaveBeenCalled();
  });

  it("does not interpret a failed backup lookup as permission to create a backup", async () => {
    const f = fixture();
    f.client.http.authedRequest.mockRejectedValueOnce(new Error("server unavailable"));
    await expect(f.safe.setup()).rejects.toThrow("server unavailable");
    expect(f.crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
    expect(f.crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
  });

  it("preserves a pending key when confirmation persistence fails", async () => {
    const f = fixture(); await f.safe.setup();
    f.checkpoint.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.safe.confirmSaved()).rejects.toThrow("disk full");
    expect(await f.make().getStatus()).toEqual({ state: "confirmation-required", recoveryKey: f.encoded });
  });
});
