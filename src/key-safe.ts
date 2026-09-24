import { MatrixError, MatrixEvent, type MatrixClient } from "matrix-js-sdk";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import { ClientPrefix } from "matrix-js-sdk/lib/http-api/prefix.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import type { CrossSigningKeys } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { KeyBackupInfo } from "matrix-js-sdk/lib/crypto-api/keybackup.js";
import { encodeUri } from "matrix-js-sdk/lib/utils.js";
import { StorageError } from "./core/errors.js";

export interface KeySafeOptions { signal?: AbortSignal }
export interface KeySafeStatus {
  state: "setup-required" | "confirmation-required" | "restore-required" | "ready";
  recoveryKey?: string;
}
export interface KeySafePersistenceOptions {
  persistentCryptoStore?: boolean;
  cryptoDatabasePrefix?: string;
  /** Flush platform crypto persistence before continuing a setup mutation. */
  onKeySafeStateChanged?: () => Promise<void>;
}
interface LocalState {
  recoveryKey?: string;
  confirmed?: boolean;
  keyId?: string;
  backupVersion?: string;
}
type WithKey = <T>(key: Uint8Array<ArrayBuffer>, fn: () => Promise<T>, signal?: AbortSignal) => Promise<T>;

/** The local saved-key acknowledgement and Matrix's existing encryption setup. */
export class DecryptionKeySafe {
  private memory: LocalState = {};
  private tail: Promise<unknown> = Promise.resolve();
  private secretRecordsRefreshed = false;
  private refreshedKeyDescriptorId: string | null = null;
  constructor(
    private client: MatrixClient,
    private withKey: WithKey,
    private options: KeySafePersistenceOptions = {},
    private startSync?: (signal?: AbortSignal) => Promise<void>,
  ) {}

  private active(signal?: AbortSignal): void {
    if (signal?.aborted) throw new StorageError("operation cancelled");
  }
  private crypto() {
    const crypto = this.client.getCrypto();
    if (!crypto) throw new StorageError("encryption is not initialized");
    return crypto;
  }
  private async local(write?: LocalState): Promise<LocalState> {
    if (this.options.persistentCryptoStore === false) {
      if (write) this.memory = write;
      return this.memory;
    }
    const prefix = this.options.cryptoDatabasePrefix ?? `telecrypt-io-storage::${this.client.getUserId()}::${this.client.getDeviceId()}`;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`${prefix}::key-safe`, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise<LocalState>((resolve, reject) => {
        const transaction = database.transaction("state", write ? "readwrite" : "readonly");
        const store = transaction.objectStore("state");
        const request = write ? store.put(write, "setup") : store.get("setup");
        transaction.oncomplete = () => resolve(write ?? request.result ?? {});
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error("key safe persistence aborted"));
      });
    } finally { database.close(); }
  }
  private async save(value: LocalState): Promise<void> {
    const previous = await this.local();
    await this.local(value);
    try { await this.options.onKeySafeStateChanged?.(); }
    catch (error) {
      await this.local(previous);
      throw error;
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private async refreshAccountData(type: string): Promise<Record<string, unknown> | null> {
    const user = this.client.getUserId();
    if (!user) throw new StorageError("Matrix login is not initialized");
    const path = encodeUri("/user/$userId/account_data/$type", { $userId: user, $type: type });
    let content: Record<string, unknown> | null;
    try {
      content = await this.client.http.authedRequest<Record<string, unknown>>(
        Method.Get, path, undefined, undefined, { prefix: ClientPrefix.V3 },
      );
    } catch (error) {
      if (!(error instanceof MatrixError) || error.errcode !== "M_NOT_FOUND") throw error;
      content = null;
    }
    // An absent account-data event is not itself an event to cache. In
    // particular, MatrixEvent normalizes null content to {}, which would make
    // SecretStorage treat an absent secret as malformed content.
    if (content !== null) {
      this.client.store.storeAccountDataEvents([new MatrixEvent({ type, sender: user, content })]);
    }
    return content;
  }
  /**
   * MatrixClient.getAccountDataFromServer reads its local store after initial
   * sync. A resumed sync can complete before account-data events reach that
   * store, so refresh the existing Safe records from the authenticated server
   * API before native secret-storage code reads them. Seed those exact records
   * through the public Store API used by Matrix sync itself.
   */
  private async refreshSecretStorageAccountData(force = false): Promise<string | null> {
    const defaultKey = await this.refreshAccountData("m.secret_storage.default_key");
    const keyId = typeof defaultKey?.key === "string" ? defaultKey.key : null;
    if (keyId && (force || this.refreshedKeyDescriptorId !== keyId)) {
      await this.refreshAccountData(`m.secret_storage.key.${keyId}`);
      this.refreshedKeyDescriptorId = keyId;
    }
    if (force || !this.secretRecordsRefreshed) {
      await Promise.all([
        this.refreshAccountData("m.cross_signing.master"),
        this.refreshAccountData("m.cross_signing.self_signing"),
        this.refreshAccountData("m.cross_signing.user_signing"),
        this.refreshAccountData("m.megolm_backup.v1"),
      ]);
      this.secretRecordsRefreshed = true;
    }
    return keyId;
  }
  private async topology(forceAccountDataRefresh = false) {
    const [defaultKeyId, backup] = await Promise.all([
      this.refreshSecretStorageAccountData(forceAccountDataRefresh), this.serverBackup(),
    ]);
    const key = await this.client.secretStorage.getKey();
    return { key, defaultKeyId, backup };
  }
  private async serverBackup(): Promise<KeyBackupInfo | null> {
    // CryptoApi.getKeyBackupInfo caches absence and maps request failures to
    // null. Neither can authorize creating a new server backup on retry.
    try {
      return await this.client.http.authedRequest<KeyBackupInfo>(Method.Get, "/room_keys/version", undefined, undefined, { prefix: ClientPrefix.V3 });
    } catch (error) {
      if (error instanceof MatrixError && error.errcode === "M_NOT_FOUND") return null;
      throw error;
    }
  }
  private async signingReady(): Promise<boolean> {
    const crypto = this.crypto();
    const user = this.client.getUserId()!;
    await crypto.userHasCrossSigningKeys(user, true);
    const [account, device, ready] = await Promise.all([
      crypto.getUserVerificationStatus(user),
      crypto.getDeviceVerificationStatus(user, this.client.getDeviceId()!),
      crypto.isCrossSigningReady(),
    ]);
    return ready && account.isVerified() && device?.signedByOwner === true;
  }
  getStatus(signal?: AbortSignal): Promise<KeySafeStatus> {
    const options = { signal };
    return this.serial(async () => {
      this.active(options.signal);
      const local = await this.local();
      if (local.recoveryKey) return { state: "confirmation-required", recoveryKey: local.recoveryKey };
      const { key, defaultKeyId, backup } = await this.topology();
      if (!key && !defaultKeyId && !backup) return { state: "setup-required" };
      if (local.confirmed && key?.[0] === local.keyId && backup?.version === local.backupVersion && await this.signingReady()) {
        await this.crypto().checkKeyBackupAndEnable();
        if (await this.crypto().getActiveSessionBackupVersion() === backup?.version) {
          this.active(options.signal);
          return { state: "ready" };
        }
      }
      this.active(options.signal);
      return { state: "restore-required" };
    });
  }
  async requireReady(options: KeySafeOptions = {}): Promise<void> {
    const status = await this.getStatus(options.signal);
    if (status.state !== "ready") throw new StorageError("Set up or unlock the Decryption Key Safe before using storage");
  }

  /** Re-publish the same native signed records after an interrupted upload. */
  private async publishSigning(signal?: AbortSignal): Promise<void> {
    const crypto = this.crypto();
    const user = this.client.getUserId()!;
    const cached = await crypto.getUserCrossSigningKeys(user);
    const server = await this.client.downloadKeysForUsers([user]);
    if (!cached?.master_key || !cached.self_signing_key || !cached.user_signing_key) {
      throw new StorageError("account signing setup is incomplete; unlock the existing Decryption Key Safe");
    }
    for (const [remote, local] of [
      [server.master_keys?.[user], cached.master_key],
      [server.self_signing_keys?.[user], cached.self_signing_key],
      [server.user_signing_keys?.[user], cached.user_signing_key],
    ]) {
      if (remote && JSON.stringify(remote.keys) !== JSON.stringify(local!.keys)) {
        throw new StorageError("account signing keys changed; unlock the existing Decryption Key Safe");
      }
    }
    this.active(signal);
    await this.client.http.authedRequest(Method.Post, "/keys/device_signing/upload", undefined, cached as CrossSigningKeys, { prefix: ClientPrefix.V3 });
    this.active(signal);
    await crypto.crossSignDevice(this.client.getDeviceId()!);
    await crypto.userHasCrossSigningKeys(user, true);
  }

  private async checkSigningCanResume(): Promise<void> {
    const user = this.client.getUserId()!;
    const [cached, server, status] = await Promise.all([
      this.crypto().getUserCrossSigningKeys(user),
      this.client.downloadKeysForUsers([user]),
      this.crypto().getCrossSigningStatus(),
    ]);
    // A new login may defer room sync until the Safe is restored. Ensure the
    // Rust crypto store has the account's public signing keys before importing
    // their private copies from secret storage; the HTTP download above alone
    // does not populate that native identity cache.
    await this.crypto().userHasCrossSigningKeys(user, true);
    const remote = server.master_keys?.[user];
    const hasPrivateKeys = Object.values(status.privateKeysCachedLocally).every(Boolean);
    if (remote && !status.privateKeysInSecretStorage && !hasPrivateKeys) {
      throw new StorageError("Use the existing account signing keys; automatic replacement is not allowed");
    }
    if (remote && hasPrivateKeys && cached?.master_key && JSON.stringify(remote.keys) !== JSON.stringify(cached.master_key.keys)) {
      throw new StorageError("Account signing keys changed; this login must unlock the existing Decryption Key Safe");
    }
  }

  private async configure(encoded: string, signal?: AbortSignal): Promise<void> {
    const crypto = this.crypto();
    const privateKey = decodeRecoveryKey(encoded);
    const { key, defaultKeyId, backup } = await this.topology(true);
    if (!key && defaultKeyId) throw new StorageError("The existing Decryption Key Safe is incomplete; it will not be replaced");
    if (key && !(await this.client.secretStorage.checkKey(privateKey, key[1]))) {
      throw new StorageError("This key does not unlock the existing Decryption Key Safe");
    }
    await this.withKey(privateKey, async () => {
      await this.checkSigningCanResume();
      this.active(signal);
      // Establish the encrypted account-data store first. Native cross-signing
      // then saves its private keys there BEFORE publishing public keys. This
      // keeps a CLI crash between native requests recoverable with the pending
      // saved key, even before its next IndexedDB snapshot reaches disk.
      if (!key) {
        await crypto.bootstrapSecretStorage({
          createSecretStorageKey: async () => ({ privateKey, encodedPrivateKey: encoded, keyInfo: {} }),
          setupNewKeyBackup: false,
        });
      }
      this.active(signal);
      // Omitting authUploadDeviceSigningKeys sends the real initial upload.
      await crypto.bootstrapCrossSigning({});
      await this.publishSigning(signal);
      this.active(signal);
      await crypto.bootstrapSecretStorage({
        createSecretStorageKey: async () => ({ privateKey, encodedPrivateKey: encoded, keyInfo: {} }),
        setupNewKeyBackup: backup === null,
      });
      this.active(signal);
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await crypto.checkKeyBackupAndEnable();
      if (!(await this.signingReady()) || !(await crypto.getActiveSessionBackupVersion())) {
        throw new StorageError("Decryption Key Safe setup has not finished; retry with the same saved key");
      }
    }, signal);
  }

  setup(signal?: AbortSignal): Promise<{ recoveryKey: string }> {
    const options = { signal };
    return this.serial(async () => {
      this.active(options.signal);
      let local = await this.local();
      if (!local.recoveryKey) {
        const { key, defaultKeyId, backup } = await this.topology(true);
        if (key || defaultKeyId || backup) throw new StorageError("A Decryption Key Safe already exists; enter its saved key to unlock it");
        const generated = await this.crypto().createRecoveryKeyFromPassphrase();
        if (!generated.encodedPrivateKey) throw new StorageError("Could not create the Decryption Key Safe key");
        local = { recoveryKey: generated.encodedPrivateKey };
        await this.save(local);
      }
      this.active(options.signal);
      await this.configure(local.recoveryKey!, options.signal);
      return { recoveryKey: local.recoveryKey! };
    });
  }
  confirmSaved(signal?: AbortSignal): Promise<{ state: "ready" }> {
    const options = { signal };
    return this.serial(async () => {
      this.active(options.signal);
      const local = await this.local();
      if (!local.recoveryKey) throw new StorageError("Set up the Decryption Key Safe and save its key before confirming");
      await this.configure(local.recoveryKey, options.signal);
      const { key, defaultKeyId, backup } = await this.topology(true);
      if (!key && defaultKeyId) throw new StorageError("The existing Decryption Key Safe is incomplete; it will not be replaced");
      if (!key || !backup?.version) throw new StorageError("Decryption Key Safe setup is incomplete");
      this.active(options.signal);
      await this.save({ confirmed: true, keyId: key[0], backupVersion: backup.version });
      return { state: "ready" };
    });
  }
  restore(recoveryKey: string, signal?: AbortSignal): Promise<{ imported: number; total: number; state: "ready" }> {
    const options = { signal };
    return this.serial(async () => {
      this.active(options.signal);
      let privateKey: Uint8Array<ArrayBuffer>;
      try { privateKey = decodeRecoveryKey(recoveryKey); }
      catch (cause) { throw new StorageError("Invalid Decryption Key Safe key", { cause }); }
      const { key, defaultKeyId, backup } = await this.topology(true);
      if (!key && defaultKeyId) throw new StorageError("The existing Decryption Key Safe is incomplete; it will not be replaced");
      if (!key || !(await this.client.secretStorage.checkKey(privateKey, key[1]))) {
        throw new StorageError("This key does not unlock the existing Decryption Key Safe");
      }
      // An interrupted first setup may have saved secret storage before it
      // created the backup. Complete those missing steps using this same key.
      if (!backup) await this.configure(recoveryKey, options.signal);
      return this.withKey(privateKey, async () => {
        const status = await this.crypto().getCrossSigningStatus();
        if (!status.privateKeysInSecretStorage && !Object.values(status.privateKeysCachedLocally).every(Boolean)) {
          throw new StorageError("Account signing keys are missing from the Decryption Key Safe; they will not be replaced");
        }
        await this.checkSigningCanResume();
        this.active(options.signal);
        await this.crypto().bootstrapCrossSigning({});
        await this.publishSigning(options.signal);
        await this.crypto().loadSessionBackupPrivateKeyFromSecretStorage();
        await this.crypto().checkKeyBackupAndEnable();
        const result = await this.crypto().restoreKeyBackup();
        // Restore room keys before starting history sync. That first sync also
        // publishes this login's device keys so Matrix can complete its
        // account-signing check.
        await this.startSync?.(options.signal);
        if (!(await this.signingReady())) throw new StorageError("This login's account signing setup is incomplete");
        this.active(options.signal);
        const currentBackup = await this.serverBackup();
        if (!currentBackup?.version) throw new StorageError("Decryption Key Safe backup is unavailable");
        await this.save({ confirmed: true, keyId: key[0], backupVersion: currentBackup.version });
        return { imported: result.imported, total: result.total, state: "ready" };
      }, options.signal);
    });
  }
}
