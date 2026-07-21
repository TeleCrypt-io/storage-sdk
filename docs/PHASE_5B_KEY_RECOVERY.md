# Spec: Real key recovery (Layer 2) + move key handling into the library

**Status:** to build. **Prereq:** Phases 0–5 are green (37 tests).

## Why this exists

The product promise is "lose your laptop, still get your files back." Today that does not
work. Phase 5 built the *front half* — bootstrap cross-signing (5.1) and generate a Recovery
Key (5.2) — but never built **server-side key backup + restore**, so a genuinely new device
cannot recover old files. Tests 5.3/5.4 were softened to hide this. This spec closes the gap.

Two layers of key persistence (both must exist):
- **Layer 1 — persistent local crypto store** (IndexedDB). Survives browser restart on the
  *same* device. Already proven by test 4.6 (`fake-indexeddb`). **Do not regress it.**
- **Layer 2 — Recovery Key + server-side Secure Backup.** The only thing that restores keys on
  a *new* device (or after clearing browser data). **This is what we build here.**

## Decision already made (do not relitigate)

Key handling lives in the **library**, not the UI wrapper. The library owns the *orchestration
and policy*; a UI would own only presentation (showing/collecting the Recovery Key). Neither
implements crypto — `matrix-js-sdk` does; we orchestrate it.

---

## Part A — Move the boundary: `TeleCryptIOStorage.create()` + a `keys` API

**Problem being fixed (a real footgun):** the library currently takes an already-built client
(`new TeleCryptIOStorage(client)`), and the harness built clients with `useIndexedDB: false` — an
in-memory, amnesiac crypto store. That is how the "no recovery" gap slipped in unnoticed. The
secure configuration must be the *default*, not something each caller wires by hand.

1. Add a factory `static async TeleCryptIOStorage.create(opts)` that:
   - Creates the `MatrixClient` and calls `initRustCrypto` with a **persistent** store by
     default (browser: IndexedDB; Node/tests: `fake-indexeddb`). Persistent is the default;
     an explicit opt-out may exist but must be a deliberate, named choice.
   - Wires the `cryptoCallbacks.getSecretStorageKey` / `cacheSecretStorageKey` needed for
     secret-storage access (see the existing pattern in `test/functional/keys.test.ts` 5.2).
   - Starts the client, waits for first sync, returns a ready `TeleCryptIOStorage`.
   - Accepts credentials (`baseUrl`, `userId`, `accessToken`, `deviceId`) and an optional
     injected key store, so platforms can supply their own.
   - Keep the existing constructor for advanced callers, but `create()` is the recommended and
     documented path.

2. Add a key-management API on `TeleCryptIOStorage` (a `keys` sub-object or methods). Minimum:
   - `setupRecovery(): Promise<{ recoveryKey: string }>` — bootstrap cross-signing + secret
     storage **with a new key backup**, and return the Recovery Key string for the UI to show.
   - `isRecoverySetup(): Promise<boolean>` — is there an active key backup + secret storage?
   - `restoreFromRecoveryKey(recoveryKey: string): Promise<{ imported: number; total: number }>`
     — on a new device: unlock secret storage with the key, load the backup key, restore the
     key backup so old files decrypt.

---

## Part B — Harness: a genuine second device

`registerTestUser()` logs a user in once (one device). Layer 2 needs a **second, empty
device** for the same user.

Add to `test/harness`:
- `loginNewDevice(user: TestUser): Promise<TestUser>` — `POST /_matrix/client/v3/login` with
  `{ type: "m.login.password", user, password }` (the password is already on `TestUser`),
  returning a **new** `device_id` + `access_token`. This is a real new device with an empty
  crypto store — the "new laptop."
- Ensure the second device's crypto store starts **empty** (it must not accidentally share
  device A's store). The tests below prove this via a negative control, so if it leaks you
  will see it.

---

## Part C — Restore tests 5.3 / 5.4 to their real (strong) form

Replace the current weak 5.3 ("recovery key can be decoded") and 5.4 ("bootstrap succeeds").

**5.3 — new device recovers files via the Recovery Key (the core test).**
1. Device A: `create()`, upload an encrypted file, `setupRecovery()` → capture `recoveryKey`.
   Wait until the key backup is active and the file's room key has been backed up
   (`getActiveSessionBackupVersion()` non-null; give the backup engine time to upload).
2. Device B: `loginNewDevice(same user)`, `create()`. **Negative control:** assert Device B
   **cannot** decrypt the file yet (no keys). This proves the empty start and that the later
   success is real.
3. Device B: `restoreFromRecoveryKey(recoveryKey)`.
4. Assert Device B **now decrypts the file** to bytes identical to what A uploaded.

**5.4 — wrong Recovery Key fails cleanly.**
- Device B with a **wrong/garbage** recovery key: `restoreFromRecoveryKey` throws (or returns
  zero imported) with a clear error, and Device B still cannot decrypt the file. Must not
  crash uncaught, must not silently "succeed."

Keep 5.1 and 5.2 (bootstrap primitives) — they can be simplified to call the new `keys` API.

---

## The matrix-js-sdk flow (verified method names — use these)

All on `client.getCrypto()!` (a `CryptoApi`). Source of truth:
`node_modules/matrix-js-sdk/src/crypto-api/index.ts`.

**Setup (Device A), inside `setupRecovery()`:**
```
await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async () => true });
await crypto.bootstrapSecretStorage({
  setupNewKeyBackup: true,       // creates a NEW key backup version (calls resetKeyBackup)
  setupNewSecretStorage: true,
  createSecretStorageKey: async () => generated,  // generated = await crypto.createRecoveryKeyFromPassphrase()
});
// generated.encodedPrivateKey is the Recovery Key string to return.
// generated.privateKey (Uint8Array) is what getSecretStorageKey must hand back later.
await crypto.checkKeyBackupAndEnable();          // ensure the backup engine is running
// then wait for getActiveSessionBackupVersion() !== null before trusting the backup.
```

**Restore (Device B), inside `restoreFromRecoveryKey(key)`:**
```
import { decodeRecoveryKey } from "matrix-js-sdk/src/crypto-api/recovery-key";
const privateKey = decodeRecoveryKey(key);       // feed this via the getSecretStorageKey callback
await crypto.loadSessionBackupPrivateKeyFromSecretStorage();  // pulls backup key out of SSSS
const res = await crypto.restoreKeyBackup();     // downloads + imports room keys
// res has imported/total counts.
```
The `getSecretStorageKey` cryptoCallback must return `[keyId, privateKey]` — see the working
example already in `keys.test.ts` (5.2). A wrong key should make secret-storage unlock /
`loadSessionBackupPrivateKeyFromSecretStorage` fail — surface that as a clean thrown error.

Note there is also `restoreKeyBackupWithPassphrase(passphrase)` if you later support
passphrase-based recovery; for v1 use the raw Recovery Key (Security Key) path above.

---

## Constraints

- **Do not break the existing 37 tests.** Migrate call sites to `create()` where it simplifies
  them, but the whole suite must stay green.
- **No mocks.** Real disposable Synapse via podman (`npm run synapse:up`; off by default —
  bring it down when done).
- Timing: key backup upload and restore are **asynchronous**. Poll with the harness `waitFor`;
  never a bare fixed sleep. If a poll must exist, poll a real condition
  (`getActiveSessionBackupVersion()`, decrypt success), not the clock.
- If Layer 2 genuinely cannot be made to work against this Synapse, do **not** weaken the
  assertions — document the exact failure in `BLOCKERS.md` and leave 5.3/5.4 failing.
- Update `STATUS.md`: 5.3/5.4 now strong; Layer 2 built; document `create()` + the `keys` API
  as the recommended entry point.
- `npm run lint` and `npm run build` must pass. Then commit and push to `origin main`.
