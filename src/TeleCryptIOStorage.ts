import {
  ClientEvent,
  createClient,
  EventType,
  MatrixClient,
  MatrixEvent,
  MatrixError,
  MsgType,
  Preset,
  RoomCreateTypeField,
  RoomType,
  SyncState,
  UNSTABLE_MSC3088_ENABLED,
  UNSTABLE_MSC3088_PURPOSE,
  UNSTABLE_MSC3089_BRANCH,
  UNSTABLE_MSC3089_LEAF,
  UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "matrix-js-sdk";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import { ClientPrefix } from "matrix-js-sdk/lib/http-api/prefix.js";
import { encryptAttachment, decryptAttachment } from "matrix-encrypt-attachment";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api/index.js";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key.js";
import type { TokenRefreshFunction } from "matrix-js-sdk/lib/http-api/index.js";
import {
  FileTooLargeError,
  RecoveryAlreadyConfiguredError,
  RecoveryRestoreError,
  RecoverySetupAmbiguousError,
  RecoverySetupError,
  RecoveryRestoreAmbiguousError,
  MutationOutcomeUnknownError,
  RoomCreationAmbiguousError,
  RoomCleanupIncompleteError,
  StorageError,
  UndecryptableFileError,
} from "./core/errors.js";
import {
  MAX_MEDIA_FILE_BYTES,
  MAX_MATRIX_IDENTIFIER_BYTES,
  validateCanonicalMatrixUserId,
  validateMatrixDeviceId,
  validateMatrixEventId,
  validateMatrixRoomId,
} from "./core/constants.js";
import {
  cancelResponseBody,
  raceWithAbort,
  readMediaResponseBody,
  readResponseBody,
  ResponseBodyReadError,
} from "./core/http.js";
import { sanitizeDiagnosticText } from "./core/oidc.js";
import { validateName } from "./core/validation.js";
import type { RecoveryStatus } from "./core/types.js";
import { isTreeDeleted } from "./deletion-markers.js";

export interface TreeSpace {
  readonly id: string;
  readonly room: { name: string };
  readonly isTopLevel: boolean;
  setName(name: string): Promise<void>;
  createDirectory(name: string): Promise<TreeSpace>;
  getDirectories(): TreeSpace[];
  getDirectory(roomId: string): TreeSpace | undefined;
  invite(userId: string, andSubspaces?: boolean): Promise<void>;
  delete(): Promise<void>;
  getOrder(): number;
  setOrder(index: number): Promise<void>;
  getPermissions(userId: string): string;
  setPermissions(userId: string, role: string): Promise<void>;
  getFile(fileEventId: string): FileBranch | null;
  listFiles(): FileBranch[];
  createFile(
    name: string,
    encryptedContents: ArrayBuffer | Uint8Array,
    info: Record<string, unknown>,
    additionalContent?: Record<string, unknown>,
  ): Promise<{ event_id: string }>;
}

export interface FileBranch {
  readonly id: string;
  readonly roomId: string;
  /** Current MSC3089 branch/listing event. Its event ID is distinct from `id` (the state key). */
  readonly indexEvent?: Pick<MatrixEvent, "getId" | "getContent" | "getSender" | "isRedacted">;
  /** Matrix SDK keeps a redacted branch in state as an inactive object. */
  readonly isActive?: boolean;
  getName(): string;
  setName(name: string): Promise<void>;
  delete(): Promise<void>;
  getFileInfo(): Promise<{
    info: Record<string, unknown>;
    httpUrl: string;
  }>;
  getFileEvent(): Promise<Pick<MatrixEvent, "getContent" | "getTs" | "isDecryptionFailure">>;
}

const STORAGE_METADATA_EVENT_TYPE = "io.telecrypt.storage.metadata";
const STORAGE_METADATA_MSGTYPE = "io.telecrypt.storage.metadata";
const GENERIC_TREE_NAME = "Encrypted storage";
const GENERIC_FILE_NAME = "Encrypted file";

type MetadataEventContent = Record<string, unknown> & {
  msgtype: string;
  body: string;
};

export interface CreateTeleCryptIOStorageOptions {
  /** Matrix homeserver base URL, e.g. "https://matrix.example.com". */
  baseUrl: string;
  /** Independently trusted Matrix server name for this deployment. */
  serverName: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  /**
   * Use a persistent crypto store (IndexedDB) so keys survive a restart on this
   * device. This is the default (`true`) — it is what makes both same-device
   * restart recovery and (via `keys.setupRecovery`/`restoreFromRecoveryKey`)
   * new-device recovery possible. Set explicitly to `false` to opt into an
   * in-memory, amnesiac store; this must be a deliberate choice, e.g. for a
   * short-lived process that should never persist secrets to disk.
   */
  persistentCryptoStore?: boolean;
  /**
   * Overrides the IndexedDB name prefix used for the crypto store. Defaults to
   * a value scoped to (userId, deviceId) so that multiple devices/users never
   * collide when they happen to share a single IndexedDB origin (e.g. in
   * Node/tests, where `fake-indexeddb` is process-global).
   */
  cryptoDatabasePrefix?: string;
  /** initialSyncLimit passed to startClient(); default 10. */
  initialSyncLimit?: number;
  /** How long to wait for the first sync before giving up; default 15000ms. */
  syncTimeoutMs?: number;
  /** How long to wait for rust-crypto WASM + IndexedDB init; default 60000ms. */
  initTimeoutMs?: number;
  /** Optional progress reporter for UI/CLI status lines during bootstrap. */
  onProgress?: (message: string) => void;
  /** Cancels bootstrap and stops the owned MatrixClient before rejecting. */
  signal?: AbortSignal;
  /**
   * Optional platform-supplied crypto callbacks (e.g. to source the secret
   * storage key from an OS keychain instead of prompting). `keys.setupRecovery`
   * and `keys.restoreFromRecoveryKey` temporarily override
   * `getSecretStorageKey`/`cacheSecretStorageKey` on this object for the
   * duration of the call, then restore whatever was here before.
   */
  cryptoCallbacks?: CryptoCallbacks;
}

/**
 * Options for `TeleCryptIOStorage.createFromOidc` — mirrors
 * `CreateTeleCryptIOStorageOptions` but sourced from an OIDC/MAS login
 * (device-code or authorization-code+PKCE, see `src/core/oidc.ts`) instead
 * of a password login. Same resulting shape either way: a ready
 * `TeleCryptIOStorage` with a persistent crypto store.
 */
export interface CreateFromOidcOptions {
  baseUrl: string;
  /** Independently trusted Matrix server name for this deployment. */
  serverName: string;
  userId: string;
  accessToken: string;
  deviceId: string;
  /** If provided (together with `tokenRefreshFunction`), wires the
   * underlying MatrixClient so an expired access token is transparently
   * refreshed mid-request. */
  refreshToken?: string;
  /** See `src/core/oidc.ts`'s `buildTokenRefreshFunction` — a plain
   * `(refreshToken) => Promise<AccessTokens>` that keeps token response
   * validation and adapter-specific persistence in the shared core. */
  tokenRefreshFunction?: TokenRefreshFunction;
  persistentCryptoStore?: boolean;
  cryptoDatabasePrefix?: string;
  initialSyncLimit?: number;
  syncTimeoutMs?: number;
  initTimeoutMs?: number;
  onProgress?: (message: string) => void;
  /** Cancels bootstrap and stops the owned MatrixClient before rejecting. */
  signal?: AbortSignal;
  cryptoCallbacks?: CryptoCallbacks;
}

const recoveryMutationQueues = new WeakMap<MatrixClient, Promise<void>>();
const treeMutationQueues = new WeakMap<MatrixClient, Promise<void>>();
const TREE_SYNC_TIMEOUT_MS = 15000;
const MEDIA_TIMEOUT_MS = 30000;
const MATRIX_HTTP_TIMEOUT_MS = 30000;
const CLEANUP_TIMEOUT_MS = 30000;
const RECOVERY_CRYPTO_TIMEOUT_MS = 60000;

function cloneCryptoCallbacks(callbacks?: CryptoCallbacks): CryptoCallbacks {
  // MatrixClient retains this object for the lifetime of the client. Keep the
  // caller's object immutable: recovery temporarily installs key callbacks on
  // the client-owned copy, never on a shared options object that another
  // client could observe concurrently.
  return callbacks ? { ...callbacks } : {};
}

/** Waits for one Matrix mutation to settle without aborting the shared client.
 * If cancellation arrives after the mutation starts, the outcome is explicitly
 * unknown: the caller must reconcile and may safely retry idempotent work. */
export function withMatrixMutationAbort<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  operationName = "Matrix mutation",
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(new StorageError("operation cancelled"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let started = false;
    let cancelled = false;
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = (): void => {
      // MatrixClient owns one HTTP abort controller for all of its requests;
      // aborting it here would cancel unrelated work. Wait for this request's
      // own promise, then report the outcome as unknown if it was in flight.
      if (started) cancelled = true;
    };
    signal.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<T>;
    started = true;
    try {
      pending = operation();
    } catch (error) {
      finish(() => reject(cancelled ? new MutationOutcomeUnknownError(operationName, { cause: error }) : error));
      return;
    }
    pending.then(
      (value) => finish(() => (cancelled ? reject(new MutationOutcomeUnknownError(operationName)) : resolve(value))),
      (error: unknown) => finish(() => reject(cancelled ? new MutationOutcomeUnknownError(operationName, { cause: error }) : error)),
    );
  });
}

async function readMatrixResponse(
  response: Response,
  signal?: AbortSignal,
  abortError?: () => Error,
): Promise<Response> {
  const body = await readResponseBody(response, signal, {
    abortError,
  });
  if (!response.body) return response;
  // Fetch forbids a response body for 204, 205, and 304 responses. Some
  // browser implementations nevertheless expose an empty response stream for
  // a 204 from a proxy. Preserve the bodyless status after consuming the
  // stream so callers such as FetchHttpApi can still read an empty Blob.
  const bodylessStatus = response.status === 204 || response.status === 205 || response.status === 304;
  if (bodylessStatus) {
    if (body.bytes.byteLength !== 0) {
      throw new Error("Matrix response body is invalid for a bodyless status");
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return new Response(body.bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function boundedMatrixFetch(fetchFn: typeof fetch): typeof fetch {
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const pending = (async (): Promise<Response> => {
      const controller = new AbortController();
      const externalSignal = init?.signal;
      const abortExternal = (): void => controller.abort(externalSignal?.reason);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Matrix request timed out"));
      }, MATRIX_HTTP_TIMEOUT_MS);
      if (externalSignal?.aborted) abortExternal();
      else externalSignal?.addEventListener("abort", abortExternal, { once: true });
      try {
        const response = await raceWithAbort(
          fetchFn(input, { ...init, redirect: "manual", signal: controller.signal }),
          controller.signal,
          () => (timedOut ? new Error("Matrix request timed out") : new DOMException("The operation was aborted", "AbortError")),
        );
        if (
          response.redirected ||
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          const failure = new Error("Matrix redirect rejected");
          cancelResponseBody(response);
          throw failure;
        }
        return await readMatrixResponse(
          response,
          controller.signal,
          () => (timedOut ? new Error("Matrix request timed out") : new DOMException("The operation was aborted", "AbortError")),
        );
      } finally {
        clearTimeout(timeout);
        externalSignal?.removeEventListener("abort", abortExternal);
      }
    })();
    return pending;
  }) as typeof fetch;
  return wrapped;
}

export interface MatrixRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Matrix SDK transport deadline, when making a direct authenticated request. */
  localTimeoutMs?: number;
  /** Internal Matrix SDK spelling used by `authedRequest`. */
  abortSignal?: AbortSignal;
}

interface MatrixHttpTransport {
  authedRequest: <T>(
    method: Method,
    path: string,
    query?: undefined,
    body?: undefined,
    options?: MatrixRequestOptions & { prefix?: string },
  ) => Promise<T>;
}

function matrixRequestTimeout(options?: MatrixRequestOptions): number {
  const value = options?.timeoutMs ?? options?.localTimeoutMs ?? MATRIX_HTTP_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("invalid Matrix request timeout");
  return value;
}

function matrixRequestSignal(options?: MatrixRequestOptions): AbortSignal | undefined {
  return options?.signal ?? options?.abortSignal;
}

function requireMatrixHttpTransport(client: MatrixClient): MatrixHttpTransport {
  const http = (client as unknown as { http?: MatrixHttpTransport }).http;
  if (!http || typeof http.authedRequest !== "function") {
    throw new StorageError("Matrix HTTP transport unavailable");
  }
  return http;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function validateHomeserverUrl(value: string): URL {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("invalid Matrix homeserver URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("invalid Matrix homeserver URL", { cause: error });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid Matrix homeserver URL");
  }
  return url;
}

function validateMatrixToken(value: string | null): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("invalid Matrix token");
  }
}

function validateMatrixIdentifier(value: string, name: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_MATRIX_IDENTIFIER_BYTES ||
    /[\s\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`invalid Matrix ${name}`);
  }
}

function validateFileName(value: string): void {
  validateName(value, "file name");
}

function validateMimetype(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;\r\n]+)*$/.test(
      value,
    )
  ) {
    throw new Error("invalid MIME type");
  }
}

export interface FileEventMetadata {
  mimetype: string | null;
  size: number | null;
}

/** Reads the event-owned metadata shared by details and download operations. */
export function readFileEventMetadata(content: unknown): FileEventMetadata {
  if (!isRecord(content)) throw new StorageError("media metadata is invalid");
  const rawInfo = content["info"];
  if (rawInfo !== undefined && !isRecord(rawInfo)) {
    throw new StorageError("media metadata is invalid");
  }
  const info = isRecord(rawInfo) ? rawInfo : undefined;
  const rawSize = info?.["size"];
  if (rawSize !== undefined) {
    if (typeof rawSize !== "number" || !Number.isSafeInteger(rawSize) || rawSize < 0) {
      throw new StorageError("media metadata is invalid");
    }
    if (rawSize > MAX_MEDIA_FILE_BYTES) throw new FileTooLargeError();
  }
  const rawMimetype = info?.["mimetype"];
  if (rawMimetype !== undefined && typeof rawMimetype !== "string") {
    throw new StorageError("media metadata is invalid");
  }
  const mimetype = rawMimetype ?? null;
  if (mimetype !== null) {
    try {
      validateMimetype(mimetype);
    } catch (error) {
      throw new StorageError("media metadata is invalid", { cause: error });
    }
  }
  return {
    mimetype,
    size: typeof rawSize === "number" ? rawSize : null,
  };
}

interface MatrixMemberEntry {
  state_key: string;
  content: { membership: string };
}

interface MatrixPowerLevels {
  users_default?: number;
  events_default?: number;
  events?: Record<string, number>;
  users?: Record<string, number>;
}

interface SecretStorageStatusShape {
  defaultKeyId: string | null;
  ready: boolean;
}

interface CrossSigningStatusShape {
  publicKeysOnDevice: boolean;
  privateKeysCachedLocally: {
    masterKey: boolean;
    selfSigningKey: boolean;
    userSigningKey: boolean;
  };
  privateKeysInSecretStorage: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSecretStorageStatus(value: unknown): SecretStorageStatusShape {
  if (!isRecord(value)) throw new RecoverySetupAmbiguousError();
  const defaultKeyId = value.defaultKeyId;
  if (defaultKeyId !== null && (typeof defaultKeyId !== "string" || defaultKeyId.length === 0)) {
    throw new RecoverySetupAmbiguousError();
  }
  if (typeof value.ready !== "boolean") throw new RecoverySetupAmbiguousError();
  return { defaultKeyId, ready: value.ready };
}

function validateBackupVersion(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    throw new RecoverySetupAmbiguousError();
  }
  return value;
}

function validateCrossSigningStatus(value: unknown): CrossSigningStatusShape {
  if (!isRecord(value) || typeof value.publicKeysOnDevice !== "boolean" ||
      typeof value.privateKeysInSecretStorage !== "boolean" ||
      !isRecord(value.privateKeysCachedLocally)) {
    throw new RecoverySetupAmbiguousError();
  }
  const cached = value.privateKeysCachedLocally;
  if (
    typeof cached.masterKey !== "boolean" ||
    typeof cached.selfSigningKey !== "boolean" ||
    typeof cached.userSigningKey !== "boolean"
  ) {
    throw new RecoverySetupAmbiguousError();
  }
  return {
    publicKeysOnDevice: value.publicKeysOnDevice,
    privateKeysCachedLocally: {
      masterKey: cached.masterKey,
      selfSigningKey: cached.selfSigningKey,
      userSigningKey: cached.userSigningKey,
    },
    privateKeysInSecretStorage: value.privateKeysInSecretStorage,
  };
}

class RecoveryCryptoTimeoutError extends Error {
  constructor(operation: string) {
    super(`recovery ${operation} timed out`);
    this.name = "RecoveryCryptoTimeoutError";
  }
}

/**
 * matrix-js-sdk's CryptoApi methods do not currently accept an AbortSignal.
 * Keep that implementation detail behind one bounded adapter so a hung WASM
 * or transport call cannot outlive the public recovery operation indefinitely.
 * The underlying promise is still observed after cancellation; some crypto
 * calls are one-way and must be treated as ambiguous by their caller.
 */
async function withRecoveryCryptoDeadline<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
  operationName: string,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new StorageError("operation cancelled"));
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("recovery crypto deadline exceeded"));
  }, RECOVERY_CRYPTO_TIMEOUT_MS);
  const abortExternal = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abortExternal();
  else signal?.addEventListener("abort", abortExternal, { once: true });
  const pending = Promise.resolve().then(operation);
  try {
    return await raceWithAbort(
      pending,
      controller.signal,
      () =>
        timedOut
          ? new RecoveryCryptoTimeoutError(operationName)
          : new StorageError("operation cancelled"),
    );
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortExternal);
  }
}

function parseMatrixMembersResponse(value: unknown): MatrixMemberEntry[] {
  if (!isRecord(value) || !Array.isArray(value.chunk)) {
    throw new Error("invalid Matrix members response");
  }
  return value.chunk.map((entry): MatrixMemberEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.state_key !== "string" ||
      !isRecord(entry.content) ||
      typeof entry.content.membership !== "string"
    ) {
      throw new Error("invalid Matrix members response");
    }
    validateMatrixIdentifier(entry.state_key, "member ID");
    validateMatrixIdentifier(entry.content.membership, "membership");
    return {
      state_key: entry.state_key,
      content: { membership: entry.content.membership },
    };
  });
}

function parseMatrixStateResponse(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("invalid Matrix room state response");
  return value.map((event): Record<string, unknown> => {
    if (
      !isRecord(event) ||
      typeof event.type !== "string" ||
      typeof event.state_key !== "string" ||
      !isRecord(event.content)
    ) {
      throw new Error("invalid Matrix room state response");
    }
    validateMatrixIdentifier(event.type, "state event type");
    if (
      new TextEncoder().encode(event.state_key).byteLength > MAX_MATRIX_IDENTIFIER_BYTES ||
      /[\s\u0000-\u001f\u007f]/.test(event.state_key)
    ) {
      throw new Error("invalid Matrix state event key");
    }
    return event;
  });
}

function parseMatrixPowerLevels(value: unknown): MatrixPowerLevels {
  if (!isRecord(value)) throw new Error("invalid Matrix power-level response");
  for (const name of ["users_default", "events_default"]) {
    const field = value[name];
    if (field !== undefined && (typeof field !== "number" || !Number.isFinite(field))) {
      throw new Error("invalid Matrix power-level response");
    }
  }
  for (const name of ["events", "users"]) {
    const field = value[name];
    if (field === undefined) continue;
    if (!isRecord(field)) throw new Error("invalid Matrix power-level response");
    for (const key of Object.keys(field)) validateMatrixIdentifier(key, `${name} key`);
    for (const level of Object.values(field)) {
      if (typeof level !== "number" || !Number.isFinite(level)) {
        throw new Error("invalid Matrix power-level response");
      }
    }
  }
  return value as MatrixPowerLevels;
}

function isGoneRoomError(error: unknown): boolean {
  return (
    error instanceof MatrixError &&
    (error.errcode === "M_NOT_FOUND" || error.errcode === "M_UNKNOWN")
  );
}

function throwWithCleanupDetail(error: unknown, roomId: string, cleanupError: unknown): never {
  const cause = new AggregateError(
    [error, cleanupError],
    "operation and room cleanup failed",
    { cause: error },
  );
  throw new RoomCleanupIncompleteError(roomId, cause);
}

/**
 * Serializes all tree mutations for one MatrixClient. A single queue is
 * intentional: separate per-room locks can deadlock when a parent mutation
 * needs to inspect or update a child while another operation does the inverse.
 * Each invocation still creates its own room; Matrix has no server-side
 * room-creation idempotency key for MSC3089.
 */
export async function withTreeMutation<T>(
  client: MatrixClient,
  operation: (signal?: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const previous = treeMutationQueues.get(client) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    return operation(signal);
  });
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  treeMutationQueues.set(client, settled);
  return run;
}

export class TeleCryptIOStorage {
  private readonly decoratedTreeSpaces = new WeakSet<object>();
  private readonly decoratedFileBranches = new WeakMap<object, FileBranch>();
  private readonly treeNames = new Map<string, string>();
  private readonly fileNames = new Map<string, string>();

  constructor(private client: MatrixClient) {
    // Advanced callers may construct a MatrixClient themselves. The SDK does
    // not mutate matrix-js-sdk internals: configure that client with the
    // supported createClient({ fetchFn, localTimeoutMs }) options, or use
    // TeleCryptIOStorage.create()/createFromOidc().
  }

  /** The underlying matrix-js-sdk client (e.g. to stop it, or for advanced/interop use). */
  getClient(): MatrixClient {
    return this.client;
  }

  private fileNameKey(treeId: string, fileId: string): string {
    return `${treeId}\u0000${fileId}`;
  }

  private getStateEvent(roomId: string, eventType: string, stateKey: string): MatrixEvent | null {
    const state = this.client.getRoom(roomId)?.currentState as unknown as {
      getStateEvents: (type: string, key: string) => MatrixEvent | MatrixEvent[] | null | undefined;
    } | undefined;
    const raw = state?.getStateEvents(eventType, stateKey);
    if (Array.isArray(raw)) return raw[0] ?? null;
    return raw ?? null;
  }

  private getTreeOwnerId(roomId: string): string {
    const create = this.getStateEvent(roomId, EventType.RoomCreate, "");
    const ownerId = create?.getSender();
    if (!ownerId) throw new StorageError("storage owner is unavailable");
    return ownerId;
  }

  private async sendEncryptedMetadataMessage(
    roomId: string,
    content: MetadataEventContent,
  ): Promise<string> {
    const response = await this.client.sendMessage(roomId, content as never);
    return validateMatrixEventId(
      (response as unknown as { event_id?: unknown } | undefined)?.event_id,
      "storage metadata response event ID",
    );
  }

  private async readEncryptedMetadataMessage(
    roomId: string,
    eventId: string,
    allowRedacted = false,
  ): Promise<MatrixEvent> {
    const rawEvent = await this.client.fetchRoomEvent(roomId, eventId);
    const event = this.client.getEventMapper()(rawEvent);
    await this.client.decryptEventIfNeeded(event);

    if (event.isDecryptionFailure()) throw new UndecryptableFileError();
    if (
      allowRedacted &&
      event.getId() === eventId &&
      event.getRoomId() === roomId &&
      event.getSender() === this.getTreeOwnerId(roomId) &&
      event.isRedacted()
    ) {
      return event;
    }
    if (
      event.getId() !== eventId ||
      event.getRoomId() !== roomId ||
      event.getSender() !== this.getTreeOwnerId(roomId) ||
      event.getWireType() !== EventType.RoomMessageEncrypted ||
      event.getType() !== EventType.RoomMessage
    ) {
      throw new StorageError("encrypted storage metadata is invalid or unavailable");
    }
    return event;
  }

  private async writeTreeName(roomId: string, name: string): Promise<void> {
    validateName(name, "name");
    const metadataEventId = await this.sendEncryptedMetadataMessage(roomId, {
      msgtype: STORAGE_METADATA_MSGTYPE,
      body: name,
    });
    await this.client.sendStateEvent(
      roomId,
      STORAGE_METADATA_EVENT_TYPE as never,
      { event_id: metadataEventId } as never,
      "",
    );
    this.treeNames.set(roomId, name);
  }

  /** Resolves an encrypted vault/folder name through its pointer state event. */
  async getTreeName(roomId: string, options?: MatrixRequestOptions): Promise<string> {
    if (options?.signal?.aborted) throw new StorageError("operation cancelled");
    await this.refreshRoomState(roomId, options);
    const pointer = this.getStateEvent(roomId, STORAGE_METADATA_EVENT_TYPE, "");
    const pointerContent = pointer?.getContent();
    if (
      !pointer ||
      pointer.getSender() !== this.getTreeOwnerId(roomId) ||
      !isRecord(pointerContent) ||
      typeof pointerContent.event_id !== "string"
    ) {
      throw new StorageError("encrypted storage name is unavailable");
    }
    const metadataEventId = validateMatrixEventId(pointerContent.event_id, "storage metadata event ID");
    let event: MatrixEvent;
    try {
      event = await this.readEncryptedMetadataMessage(roomId, metadataEventId);
    } catch (error) {
      // A new device can list storage before restoring room keys. Keep the
      // room visible with a generic label; a later call retries decryption.
      if (error instanceof UndecryptableFileError) return GENERIC_TREE_NAME;
      throw error;
    }
    const content = event.getContent();
    if (
      !isRecord(content) ||
      content.msgtype !== STORAGE_METADATA_MSGTYPE ||
      typeof content.body !== "string" ||
      Object.hasOwn(content, "file_event_id")
    ) {
      throw new StorageError("encrypted storage name is invalid or unavailable");
    }
    validateName(content.body, "name");
    this.treeNames.set(roomId, content.body);
    return content.body;
  }

  private async writeFileName(treeId: string, fileId: string, name: string): Promise<void> {
    validateName(name, "file name");
    validateMatrixEventId(fileId, "file event ID");
    const metadataEventId = await this.sendEncryptedMetadataMessage(treeId, {
      msgtype: STORAGE_METADATA_MSGTYPE,
      body: name,
      file_event_id: fileId,
    });
    await this.client.sendStateEvent(
      treeId,
      UNSTABLE_MSC3089_BRANCH.name,
      { active: true, metadata_event_id: metadataEventId } as never,
      fileId,
    );
    this.fileNames.set(this.fileNameKey(treeId, fileId), name);
  }

  /** Resolves an encrypted file name from the MSC3089 index pointer. */
  async getFileName(
    treeId: string,
    fileId: string,
    options?: MatrixRequestOptions & { refreshState?: boolean },
  ): Promise<string> {
    if (options?.signal?.aborted) throw new StorageError("operation cancelled");
    if (options?.refreshState !== false) await this.refreshRoomState(treeId, options);
    const tree = this.getTree(treeId);
    const branch = tree?.getFile(fileId);
    if (!branch || branch.isActive === false) throw new StorageError("file not found");
    const indexEvent = branch.indexEvent;
    const indexContent = indexEvent?.getContent();
    if (
      !indexEvent ||
      indexEvent.getSender() !== this.getTreeOwnerId(treeId) ||
      !isRecord(indexContent) ||
      indexContent.active !== true ||
      typeof indexContent.metadata_event_id !== "string"
    ) {
      throw new StorageError("encrypted file name is unavailable");
    }
    const metadataEventId = validateMatrixEventId(
      indexContent.metadata_event_id,
      "file metadata event ID",
    );
    let event: MatrixEvent;
    try {
      event = await this.readEncryptedMetadataMessage(treeId, metadataEventId);
    } catch (error) {
      // File IDs remain listable on a fresh device while its room keys are
      // being restored. The caller can resolve the private name on retry.
      if (error instanceof UndecryptableFileError) return GENERIC_FILE_NAME;
      throw error;
    }
    const content = event.getContent();
    if (!isRecord(content) || typeof content.body !== "string") {
      throw new StorageError("encrypted file name is invalid or unavailable");
    }
    if (content.msgtype === MsgType.File) {
      if (metadataEventId !== fileId || !isRecord(content.file)) {
        throw new StorageError("encrypted file metadata does not match its listing");
      }
    } else if (
      content.msgtype !== STORAGE_METADATA_MSGTYPE ||
      content.file_event_id !== fileId
    ) {
      throw new StorageError("encrypted file metadata does not match its listing");
    }
    validateName(content.body, "file name");
    this.fileNames.set(this.fileNameKey(treeId, fileId), content.body);
    return content.body;
  }

  /** Returns the current file metadata pointer, including on inactive branches. */
  async getFileMetadataEventId(
    treeId: string,
    fileId: string,
    options?: MatrixRequestOptions,
  ): Promise<string | null> {
    if (options?.signal?.aborted) throw new StorageError("operation cancelled");
    await this.refreshRoomState(treeId, options);
    const branch = this.getTree(treeId)?.getFile(fileId);
    if (!branch) throw new StorageError("file not found");
    const indexEvent = branch.indexEvent;
    const content = indexEvent?.getContent();
    if (!indexEvent || indexEvent.getSender() !== this.getTreeOwnerId(treeId)) {
      throw new StorageError("encrypted file listing is unavailable");
    }
    if (
      !isRecord(content) ||
      typeof content.metadata_event_id !== "string"
    ) {
      if (branch.isActive === false || indexEvent.isRedacted()) return null;
      throw new StorageError("encrypted file name is unavailable");
    }
    return validateMatrixEventId(content.metadata_event_id, "file metadata event ID");
  }

  /** Fetches and validates a current encrypted rename event, allowing retries after redaction. */
  async getFileRenameMetadataEvent(
    treeId: string,
    fileId: string,
    metadataEventId: string,
  ): Promise<MatrixEvent> {
    const event = await this.readEncryptedMetadataMessage(treeId, metadataEventId, true);
    if (event.isRedacted()) return event;
    const content = event.getContent();
    if (
      !isRecord(content) ||
      content.msgtype !== STORAGE_METADATA_MSGTYPE ||
      content.file_event_id !== fileId ||
      typeof content.body !== "string"
    ) {
      throw new StorageError("encrypted file metadata does not match its listing");
    }
    validateName(content.body, "file name");
    return event;
  }

  /** Fetches the original encrypted file message directly by event ID. */
  async getOriginalFileEvent(
    treeId: string,
    fileId: string,
    allowRedacted = false,
  ): Promise<MatrixEvent> {
    const event = await this.readEncryptedMetadataMessage(treeId, fileId, allowRedacted);
    if (event.isRedacted() && allowRedacted) return event;
    const content = event.getContent();
    if (
      !isRecord(content) ||
      content.msgtype !== MsgType.File ||
      typeof content.body !== "string" ||
      !isRecord(content.file) ||
      typeof content.file.url !== "string"
    ) {
      throw new StorageError("encrypted file message is invalid or unavailable");
    }
    return event;
  }

  private async createEncryptedFile(
    treeId: string,
    name: string,
    encryptedContents: ArrayBuffer | Uint8Array,
    info: Record<string, unknown>,
    additionalContent?: Record<string, unknown>,
  ): Promise<{ event_id: string }> {
    validateFileName(name);
    const bytes = encryptedContents instanceof Uint8Array
      ? encryptedContents
      : new Uint8Array(encryptedContents);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const uploaded = await this.client.uploadContent(body, { includeFilename: false });
    if (typeof uploaded.content_uri !== "string" || uploaded.content_uri.length === 0) {
      throw new StorageError("encrypted media upload returned no content URI");
    }
    const fileInfo = { ...info, url: uploaded.content_uri };
    const fileContent: Record<string, unknown> = {
      ...additionalContent,
      msgtype: MsgType.File,
      body: name,
      url: uploaded.content_uri,
      file: fileInfo,
      [UNSTABLE_MSC3089_LEAF.name]: {},
    };
    const sent = await this.client.sendMessage(treeId, fileContent as never);
    const fileEventId = validateMatrixEventId(
      (sent as unknown as { event_id?: unknown } | undefined)?.event_id,
      "file upload response event ID",
    );
    await this.client.sendStateEvent(
      treeId,
      UNSTABLE_MSC3089_BRANCH.name,
      { active: true, metadata_event_id: fileEventId } as never,
      fileEventId,
    );
    this.fileNames.set(this.fileNameKey(treeId, fileEventId), name);
    return { event_id: fileEventId };
  }

  /**
   * Refreshes a room's current state from the homeserver. The background sync
   * loop is intentionally asynchronous, so a short-lived CLI process can
   * otherwise list a stale state snapshot immediately after another process
   * changed a file name or branch.
   */
  async refreshRoomState(roomId: string, options?: MatrixRequestOptions): Promise<void> {
    const room = this.client.getRoom(roomId);
    if (!room) throw new Error("unknown room");
    const http = requireMatrixHttpTransport(this.client);
    const stateEvents = await http.authedRequest<Array<Record<string, unknown>>>(
      Method.Get,
      `/rooms/${encodeURIComponent(roomId)}/state`,
      undefined,
      undefined,
      {
        prefix: ClientPrefix.V3,
        localTimeoutMs: matrixRequestTimeout(options),
        abortSignal: matrixRequestSignal(options),
      },
    );
    const parsedStateEvents = parseMatrixStateResponse(stateEvents);
    if (typeof room.currentState.setStateEvents === "function") {
      const refreshed = parsedStateEvents.map((event) => new MatrixEvent(event as never));
      // RoomState.setStateEvents overwrites matching tuples, but deliberately
      // retains tuples absent from the input.  Replace those stale local
      // events with empty-content state events so a refresh is an exact server
      // snapshot instead of a union with old state.  This is important for
      // relation checks: a stale child/parent link must not authorize a
      // destructive operation.
      const currentEvents = (room.currentState as unknown as {
        events?: Map<string, Map<string, MatrixEvent>>;
      }).events;
      if (currentEvents instanceof Map) {
        const present = new Set(
          refreshed.map((event) => `${event.getType()}\u0000${event.getStateKey() ?? ""}`),
        );
        for (const [eventType, byStateKey] of currentEvents) {
          for (const [stateKey, event] of byStateKey) {
            if (present.has(`${eventType}\u0000${stateKey}`)) continue;
            const original = event.getEffectiveEvent();
            refreshed.push(
              new MatrixEvent({
                ...original,
                content: {},
                unsigned: { ...original.unsigned },
              }),
            );
          }
        }
      }
      room.currentState.setStateEvents(refreshed);
    }
  }

  /**
   * Recommended entry point: builds the MatrixClient with a persistent crypto
   * store and the secret-storage callback wiring `keys.*` needs, starts the
   * client, waits for the first sync, and returns a ready TeleCryptIOStorage.
   *
   * The plain constructor remains available for advanced callers who need to
   * build/configure the MatrixClient themselves; in that case `keys.*` only
   * works if the caller wires equivalent cryptoCallbacks onto the client at
   * construction time (see `cryptoCallbacks` above for why: matrix-js-sdk
   * captures a single callbacks object at MatrixClient construction, so it
   * must exist before `initRustCrypto` runs, not be added afterwards).
  */
  static async create(opts: CreateTeleCryptIOStorageOptions): Promise<TeleCryptIOStorage> {
    const baseUrl = validateHomeserverUrl(opts.baseUrl).toString();
    validateCanonicalMatrixUserId(opts.userId, opts.serverName);
    validateMatrixDeviceId(opts.deviceId);
    validateMatrixToken(opts.accessToken);
    TeleCryptIOStorage.throwIfAborted(opts.signal);
    const client = createClient({
      baseUrl,
      userId: opts.userId,
      accessToken: opts.accessToken,
      deviceId: opts.deviceId,
      fetchFn: boundedMatrixFetch(globalThis.fetch.bind(globalThis)),
      localTimeoutMs: MATRIX_HTTP_TIMEOUT_MS,
      cryptoCallbacks: cloneCryptoCallbacks(opts.cryptoCallbacks),
    });

    return TeleCryptIOStorage.bootstrap(client, opts);
  }

  /**
   * As `create()`, but the resulting `MatrixClient` was authenticated via
   * OIDC/MAS (device-code or authorization-code+PKCE — see
   * `src/core/oidc.ts`) rather than `m.login.password`. If `refreshToken` +
   * `tokenRefreshFunction` are both given, the client's `tokenRefreshFunction` is
   * wired so an expired access token is transparently refreshed mid-request
   * — same mechanism matrix-js-sdk uses for any refresh-token-capable login.
  */
  static async createFromOidc(opts: CreateFromOidcOptions): Promise<TeleCryptIOStorage> {
    const baseUrl = validateHomeserverUrl(opts.baseUrl).toString();
    validateCanonicalMatrixUserId(opts.userId, opts.serverName);
    validateMatrixDeviceId(opts.deviceId);
    validateMatrixToken(opts.accessToken);
    if (opts.refreshToken !== undefined) validateMatrixToken(opts.refreshToken);
    TeleCryptIOStorage.throwIfAborted(opts.signal);
    const client = createClient({
      baseUrl,
      userId: opts.userId,
      accessToken: opts.accessToken,
      deviceId: opts.deviceId,
      refreshToken: opts.refreshToken,
      tokenRefreshFunction:
        opts.refreshToken && opts.tokenRefreshFunction ? opts.tokenRefreshFunction : undefined,
      fetchFn: boundedMatrixFetch(globalThis.fetch.bind(globalThis)),
      localTimeoutMs: MATRIX_HTTP_TIMEOUT_MS,
      cryptoCallbacks: cloneCryptoCallbacks(opts.cryptoCallbacks),
    });

    return TeleCryptIOStorage.bootstrap(client, opts);
  }

  /** Shared post-construction bootstrap for `create()`/`createFromOidc()`:
   * persistent crypto store, first sync, wrap in a `TeleCryptIOStorage`. */
  private static async bootstrap(
    client: MatrixClient,
    opts: Pick<
      CreateTeleCryptIOStorageOptions,
      | "userId"
      | "deviceId"
      | "persistentCryptoStore"
      | "cryptoDatabasePrefix"
      | "initialSyncLimit"
      | "syncTimeoutMs"
      | "initTimeoutMs"
      | "onProgress"
      | "signal"
    >,
  ): Promise<TeleCryptIOStorage> {
    const progress = opts.onProgress ?? (() => {});
    const persistent = opts.persistentCryptoStore ?? true;
    try {
      progress("Loading encryption engine (WASM)…");
      await TeleCryptIOStorage.withTimeout(
        client.initRustCrypto({
          useIndexedDB: persistent,
          cryptoDatabasePrefix:
            opts.cryptoDatabasePrefix ?? `telecrypt-io-storage::${opts.userId}::${opts.deviceId}`,
        }),
        opts.initTimeoutMs ?? 60000,
        "crypto init",
        opts.signal,
      );
      progress("Encryption ready — opening secure store…");

      progress("Starting Matrix client…");
      // Mark this before awaiting: startClient can start its sync loop and then
      // reject while reporting an error from the initial request.
      await TeleCryptIOStorage.withTimeout(
        client.startClient({ initialSyncLimit: opts.initialSyncLimit ?? 10 }),
        opts.syncTimeoutMs ?? 15000,
        "client start",
        opts.signal,
      );

      progress("Waiting for first sync with homeserver…");
      await TeleCryptIOStorage.waitForFirstSync(client, opts.syncTimeoutMs ?? 15000, opts.signal);
      TeleCryptIOStorage.throwIfAborted(opts.signal);
      progress("Sync complete.");

      return new TeleCryptIOStorage(client);
    } catch (error) {
      // stopClient is idempotent in matrix-js-sdk and is also required after
      // init/timeout failures: crypto startup can have installed listeners or
      // a sync task before the awaited operation rejects.
      try {
        client.stopClient();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "storage bootstrap and client cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  private static throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("storage bootstrap cancelled");
  }

  private static withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = () => settle(() => reject(new Error("storage bootstrap cancelled")));
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`${label} timeout after ${ms}ms`)));
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      promise.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  /** Bounds a Matrix mutation without cancelling a shared client's other
   * requests. A timeout means the server may have committed the mutation. */
  private static withMutationTimeout<T>(
    promise: Promise<T>,
    ms: number,
    operation: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new MutationOutcomeUnknownError(operation));
      }, ms);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Wait until the client reaches Prepared/Syncing. Ignores transient
   * pre-sync states instead of rejecting on the first Sync event (which can
   * race `startClient`), and handles the case where sync already completed
   * before the listener was attached. */
  private static waitForFirstSync(
    client: MatrixClient,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    TeleCryptIOStorage.throwIfAborted(signal);
    const ready = (state: SyncState | null) =>
      state === SyncState.Prepared || state === SyncState.Syncing;

    if (ready(client.getSyncState())) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        client.removeListener(ClientEvent.Sync, onSync);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onSync = (state: SyncState) => {
        if (ready(state)) settle(() => resolve());
      };
      const onAbort = () => settle(() => reject(new Error("storage bootstrap cancelled")));
      const timeout = setTimeout(() => {
        settle(() => reject(new Error("sync timeout")));
      }, timeoutMs);
      client.on(ClientEvent.Sync, onSync);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private requireCrypto() {
    const crypto = this.client.getCrypto();
    if (!crypto) {
      throw new Error(
        "TeleCryptIOStorage: this client's crypto was never initialised (call client.initRustCrypto() first, or use TeleCryptIOStorage.create())",
      );
    }
    return crypto;
  }

  /**
   * Temporarily wires `getSecretStorageKey`/`cacheSecretStorageKey` on the
   * client's cryptoCallbacks to hand back `privateKey`, runs `fn`, then
   * restores whatever callbacks were there before — regardless of success or
   * failure. Requires that the client was constructed with a cryptoCallbacks
   * object in the first place (see `create()`'s doc comment).
   */
  private async withSecretStorageKey<T>(
    privateKey: Uint8Array<ArrayBuffer>,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const crypto = this.requireCrypto();
    const rawStatus = await withRecoveryCryptoDeadline(
      () => crypto.getSecretStorageStatus(),
      signal,
      "secret-storage status",
    );
    const status = validateSecretStorageStatus(rawStatus);
    // A restore must use the account's current default key. During setup the
    // default does not exist yet, so the SDK permits exactly one requested key
    // and pins that ID for the remainder of the operation. Any ambiguous or
    // unrelated request fails closed instead of handing the same private key
    // to an arbitrary secret-storage slot.
    let selectedKeyId = status.defaultKeyId ?? undefined;
    const callbacks = this.client.cryptoCallbacks;
    const prevGetKey = callbacks.getSecretStorageKey;
    const prevCache = callbacks.cacheSecretStorageKey;
    callbacks.getSecretStorageKey = async ({ keys }) => {
      const keyIds = Object.keys(keys);
      if (keyIds.length === 0) return null;
      if (selectedKeyId === undefined) {
        if (keyIds.length !== 1) return null;
        selectedKeyId = keyIds[0];
      }
      if (!Object.prototype.hasOwnProperty.call(keys, selectedKeyId)) return null;
      return [selectedKeyId, privateKey] as [string, Uint8Array<ArrayBuffer>];
    };
    callbacks.cacheSecretStorageKey = () => {};
    try {
      return await fn();
    } finally {
      callbacks.getSecretStorageKey = prevGetKey;
      callbacks.cacheSecretStorageKey = prevCache;
    }
  }

  private async withRecoveryMutation<T>(
    operation: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = recoveryMutationQueues.get(this.client) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      return operation(signal);
    });
    recoveryMutationQueues.set(
      this.client,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /**
   * Bootstraps cross-signing and secret storage with a brand-new server-side
   * key backup, and returns the Recovery Key for the caller to show the user.
   * This is what makes `restoreFromRecoveryKey` on another device possible.
   */
  private async keysSetupRecovery(signal?: AbortSignal): Promise<{ recoveryKey: string }> {
    return this.withRecoveryMutation((queuedSignal) => this.performKeysSetupRecovery(queuedSignal), signal);
  }

  private async performKeysSetupRecovery(signal?: AbortSignal): Promise<{ recoveryKey: string }> {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    const crypto = this.requireCrypto();

    // Recovery setup is deliberately one-way for an account. Replacing an
    // existing secret-storage key or backup can strand files on other devices;
    // never disable or reset either resource just to mint a new key.
    let status: SecretStorageStatusShape;
    let backupVersion: string | null;
    let crossSigningStatus: CrossSigningStatusShape | undefined;
    try {
      const crossSigningPromise =
        typeof crypto.getCrossSigningStatus === "function"
          ? withRecoveryCryptoDeadline(() => crypto.getCrossSigningStatus(), signal, "cross-signing status")
          : Promise.resolve(undefined);
      const [rawStatus, rawBackupVersion, rawCrossSigningStatus] = await Promise.all([
        withRecoveryCryptoDeadline(() => crypto.getSecretStorageStatus(), signal, "secret-storage status"),
        withRecoveryCryptoDeadline(() => crypto.getActiveSessionBackupVersion(), signal, "backup status"),
        crossSigningPromise,
      ]);
      const validatedStatus = validateSecretStorageStatus(rawStatus);
      const validatedBackupVersion = validateBackupVersion(rawBackupVersion);
      const validatedCrossSigningStatus =
        rawCrossSigningStatus === undefined
          ? undefined
          : validateCrossSigningStatus(rawCrossSigningStatus);
      status = validatedStatus;
      backupVersion = validatedBackupVersion;
      crossSigningStatus = validatedCrossSigningStatus;
    } catch (error) {
      // A failed preflight cannot prove that recovery is absent. This is a
      // permanent fail-closed boundary: callers must obtain an independent
      // status result before attempting another one-way setup.
      if (signal?.aborted && error instanceof StorageError) {
        throw error;
      }
      throw new RecoverySetupAmbiguousError(error);
    }
    if (status.defaultKeyId || status.ready || backupVersion !== null) {
      throw new RecoveryAlreadyConfiguredError();
    }
    if (
      crossSigningStatus?.publicKeysOnDevice &&
      !crossSigningStatus.privateKeysInSecretStorage &&
      !Object.values(crossSigningStatus.privateKeysCachedLocally).every(Boolean)
    ) {
      throw new RecoverySetupAmbiguousError();
    }
    if (signal?.aborted) throw new StorageError("operation cancelled");

    try {
      await withRecoveryCryptoDeadline(() => crypto.bootstrapCrossSigning({
        // No existing verified device to interactively re-authenticate against
        // for this account, so there is nothing to feed into `makeRequest`;
        // matches the working pattern already proven in keys.test.ts.
        authUploadDeviceSigningKeys: async () => undefined,
      }), signal, "cross-signing bootstrap");
    } catch (error) {
      // Cross-signing setup can commit server-side state before a transport
      // failure is observed. Do not turn that uncertainty into a retry that
      // could replace recovery state.
      throw new RecoverySetupAmbiguousError(error);
    }
    // CryptoApi mutations do not accept an AbortSignal. Once one has settled,
    // do not cross the next one-way mutation boundary: the caller may already
    // have timed out and would otherwise lose the only key it could display.
    if (signal?.aborted) throw new RecoverySetupAmbiguousError();

    let generated: Awaited<ReturnType<typeof crypto.createRecoveryKeyFromPassphrase>>;
    try {
      generated = await withRecoveryCryptoDeadline(
        () => crypto.createRecoveryKeyFromPassphrase(),
        signal,
        "recovery-key generation",
      );
    } catch (error) {
      throw new RecoverySetupAmbiguousError(error);
    }
    if (!generated.encodedPrivateKey) {
      throw new RecoverySetupAmbiguousError();
    }
    if (signal?.aborted) throw new RecoverySetupAmbiguousError();

    let generatedWasUsed = false;
    try {
      await this.withSecretStorageKey(generated.privateKey, async () => {
        if (signal?.aborted) throw new RecoverySetupAmbiguousError();
        await withRecoveryCryptoDeadline(() => crypto.bootstrapSecretStorage({
            createSecretStorageKey: async () => {
              if (signal?.aborted) throw new RecoverySetupAmbiguousError();
              generatedWasUsed = true;
              return generated;
            },
            // The preflight above proves that this account has no active
            // backup.  Matrix 42 does not create a backup when this option is
            // omitted; it only stores a key for an already-existing backup.
            // Keep the preflight/postflight ambiguity handling around this
            // one-way operation: an uncertain result must never be retried.
            // The per-client queue closes the local race; callers must inspect
            // the resulting status before attempting setup from another client.
            setupNewKeyBackup: true,
          }), signal, "secret-storage bootstrap");
        if (signal?.aborted) throw new RecoverySetupAmbiguousError();
        await withRecoveryCryptoDeadline(
          () => crypto.checkKeyBackupAndEnable(),
          signal,
          "key-backup enable",
        );
      }, signal);
      if (signal?.aborted) throw new RecoverySetupAmbiguousError();
      if (!generatedWasUsed) throw new RecoverySetupAmbiguousError();
    } catch (error) {
      if (error instanceof RecoverySetupAmbiguousError) throw error;
      // Both calls can commit server-side state before a transport error. A
      // status probe distinguishes a clean failure from an unsafe retry.
      try {
        const [rawAfterStatus, rawAfterBackup] = await Promise.all([
          withRecoveryCryptoDeadline(() => crypto.getSecretStorageStatus(), signal, "secret-storage status"),
          withRecoveryCryptoDeadline(() => crypto.getActiveSessionBackupVersion(), signal, "backup status"),
        ]);
        const afterStatus = validateSecretStorageStatus(rawAfterStatus);
        const afterBackup = validateBackupVersion(rawAfterBackup);
        if (afterStatus.defaultKeyId || afterStatus.ready || afterBackup !== null) {
          throw new RecoverySetupAmbiguousError();
        }
      } catch (statusError) {
        if (statusError instanceof RecoverySetupAmbiguousError) {
          throw new RecoverySetupAmbiguousError(
            new AggregateError([error, statusError], "recovery setup and status verification were both inconclusive", {
              cause: error,
            }),
          );
        }
        if (statusError instanceof RecoverySetupError) throw statusError;
        // A failed status probe cannot prove that the one-way operation did
        // not commit. Never turn that uncertainty into an apparently safe
        // retry that could replace account recovery state.
        throw new RecoverySetupAmbiguousError(
          new AggregateError([error, statusError], "recovery setup and status verification failed", {
            cause: error,
          }),
        );
      }
      throw new RecoverySetupError(error);
    }

    try {
      const [rawAfterStatus, rawAfterBackup] = await Promise.all([
        withRecoveryCryptoDeadline(() => crypto.getSecretStorageStatus(), signal, "secret-storage status"),
        withRecoveryCryptoDeadline(() => crypto.getActiveSessionBackupVersion(), signal, "backup status"),
      ]);
      const afterStatus = validateSecretStorageStatus(rawAfterStatus);
      const afterBackup = validateBackupVersion(rawAfterBackup);
      if (!afterStatus.ready || afterBackup === null) throw new RecoverySetupAmbiguousError();
    } catch (error) {
      if (error instanceof RecoverySetupAmbiguousError) throw error;
      throw new RecoverySetupAmbiguousError(error);
    }

    // This is the last boundary before exposing the only recovery credential
    // to the caller. Cancellation here must not return a key that the caller
    // may already have abandoned.
    if (signal?.aborted) throw new RecoverySetupAmbiguousError();
    return { recoveryKey: generated.encodedPrivateKey };
  }

  /** Is there an active key backup and a ready secret storage right now? */
  private async keysIsRecoverySetup(signal?: AbortSignal): Promise<boolean> {
    return this.withRecoveryMutation(
      (queuedSignal) => {
        if (queuedSignal?.aborted) throw new StorageError("operation cancelled");
        return this.performKeysIsRecoverySetup(queuedSignal);
      },
      signal,
    );
  }

  private async performKeysIsRecoverySetup(signal?: AbortSignal): Promise<boolean> {
    const crypto = this.client.getCrypto();
    if (!crypto) return false;
    try {
      const [rawStorageStatus, rawBackupVersion] = await Promise.all([
        withRecoveryCryptoDeadline(() => crypto.getSecretStorageStatus(), signal, "secret-storage status"),
        withRecoveryCryptoDeadline(() => crypto.getActiveSessionBackupVersion(), signal, "backup status"),
      ]);
      const storageStatus = validateSecretStorageStatus(rawStorageStatus);
      const backupVersion = validateBackupVersion(rawBackupVersion);
      return storageStatus.ready && backupVersion !== null;
    } catch (error) {
      throw new RecoverySetupAmbiguousError(error);
    }
  }

  /** Returns one consistent recovery topology snapshot without exposing raw crypto callbacks. */
  private async keysGetRecoveryStatus(signal?: AbortSignal): Promise<RecoveryStatus> {
    return this.withRecoveryMutation(
      async (queuedSignal) => {
        if (queuedSignal?.aborted) throw new StorageError("operation cancelled");
        const crypto = this.requireCrypto();
        try {
          const [rawSecretStorage, rawBackupVersion, rawCrossSigning] = await Promise.all([
            withRecoveryCryptoDeadline(() => crypto.getSecretStorageStatus(), queuedSignal, "secret-storage status"),
            withRecoveryCryptoDeadline(() => crypto.getActiveSessionBackupVersion(), queuedSignal, "backup status"),
            withRecoveryCryptoDeadline(() => crypto.getCrossSigningStatus(), queuedSignal, "cross-signing status"),
          ]);
          const secretStorage = validateSecretStorageStatus(rawSecretStorage);
          const backupVersion = validateBackupVersion(rawBackupVersion);
          const crossSigning = validateCrossSigningStatus(rawCrossSigning);
          const privateKeysCachedLocally = Object.values(crossSigning.privateKeysCachedLocally).every(Boolean);
          const ready =
            crossSigning.publicKeysOnDevice &&
            (privateKeysCachedLocally || crossSigning.privateKeysInSecretStorage) &&
            secretStorage.ready &&
            backupVersion !== null;
          const unconfigured =
            !crossSigning.publicKeysOnDevice &&
            !secretStorage.defaultKeyId &&
            backupVersion === null;
          return {
            state: ready ? "ready" : unconfigured ? "unconfigured" : "partial",
            crossSigning: {
              publicKeysOnDevice: crossSigning.publicKeysOnDevice,
              privateKeysCachedLocally,
              privateKeysInSecretStorage: crossSigning.privateKeysInSecretStorage,
            },
            secretStorage: {
              ready: secretStorage.ready,
              defaultKeyId: secretStorage.defaultKeyId,
            },
            backupVersion,
          };
        } catch (error) {
          throw new RecoverySetupAmbiguousError(error);
        }
      },
      signal,
    );
  }

  /**
   * On a new device: unlocks secret storage with the Recovery Key, loads the
   * key-backup decryption key out of secret storage, and restores the key
   * backup so previously-uploaded files become decryptable again.
   *
   * Throws a clear error (never silently "succeeds" with zero keys) if the
   * recovery key is malformed or does not unlock this account's secret
   * storage / key backup.
   */
  private async keysRestoreFromRecoveryKey(
    recoveryKey: string,
    signal?: AbortSignal,
  ): Promise<{ imported: number; total: number }> {
    return this.withRecoveryMutation(
      (queuedSignal) => this.performKeysRestoreFromRecoveryKey(recoveryKey, queuedSignal),
      signal,
    );
  }

  private async performKeysRestoreFromRecoveryKey(
    recoveryKey: string,
    signal?: AbortSignal,
  ): Promise<{ imported: number; total: number }> {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    const crypto = this.requireCrypto();

    if (
      typeof recoveryKey !== "string" ||
      recoveryKey.length === 0 ||
      /[^A-Za-z0-9 ]/.test(recoveryKey)
    ) {
      throw new RecoveryRestoreError();
    }

    let privateKey: Uint8Array<ArrayBuffer>;
    try {
      privateKey = decodeRecoveryKey(recoveryKey);
    } catch (error) {
      throw new RecoveryRestoreError(error);
    }
    if (signal?.aborted) throw new StorageError("operation cancelled");

    return this.withSecretStorageKey(privateKey, async () => {
      try {
        await withRecoveryCryptoDeadline(
          () => crypto.loadSessionBackupPrivateKeyFromSecretStorage(),
          signal,
          "backup-key load",
        );
        if (signal?.aborted) throw new RecoveryRestoreAmbiguousError();
      } catch (error) {
        if (error instanceof RecoveryRestoreAmbiguousError) throw error;
        throw new RecoveryRestoreError(error);
      }

      try {
        const result = await withRecoveryCryptoDeadline(
          () => crypto.restoreKeyBackup(),
          signal,
          "key-backup restore",
        );
        if (signal?.aborted) throw new RecoveryRestoreAmbiguousError();
        if (!Number.isSafeInteger(result.imported) || !Number.isSafeInteger(result.total) || result.imported < 0 || result.total < result.imported) {
          throw new RecoveryRestoreError();
        }
        return { imported: result.imported, total: result.total };
      } catch (error) {
        if (error instanceof RecoveryRestoreAmbiguousError) throw error;
        if (error instanceof RecoveryRestoreError) throw error;
        throw new RecoveryRestoreError(error);
      }
    }, signal);
  }

  /** Key-management API: setup, status, and restore for server-side Secure Backup. */
  get keys(): {
    setupRecovery: (signal?: AbortSignal) => Promise<{ recoveryKey: string }>;
    isRecoverySetup: (signal?: AbortSignal) => Promise<boolean>;
    getStatus: (signal?: AbortSignal) => Promise<RecoveryStatus>;
    restoreFromRecoveryKey: (
      recoveryKey: string,
      signal?: AbortSignal,
    ) => Promise<{ imported: number; total: number }>;
  } {
    return {
      setupRecovery: (signal?: AbortSignal) => this.keysSetupRecovery(signal),
      isRecoverySetup: (signal?: AbortSignal) => this.keysIsRecoverySetup(signal),
      getStatus: (signal?: AbortSignal) => this.keysGetRecoveryStatus(signal),
      restoreFromRecoveryKey: (recoveryKey: string, signal?: AbortSignal) =>
        this.keysRestoreFromRecoveryKey(recoveryKey, signal),
    };
  }

  /**
   * Creates a new top-level shared vault (tree space).
   *
   * Uses Matrix's public `createRoom()` response as the authoritative room
   * identity, then waits for that exact room to appear in local sync state.
   */
  private treeRoomOptions(name: string) {
    validateName(name, "name");
    const userId = this.client.getUserId();
    if (!userId) throw new Error("createTree: Matrix client has no user ID");

    return {
      name: GENERIC_TREE_NAME,
      preset: Preset.PrivateChat,
      power_level_content_override: {
        invite: 100,
        kick: 100,
        ban: 100,
        redact: 100,
        state_default: 0,
        events_default: 0,
        users_default: 0,
        events: {
          [EventType.RoomPowerLevels]: 100,
          [EventType.RoomHistoryVisibility]: 100,
          [EventType.RoomTombstone]: 100,
          [EventType.RoomEncryption]: 100,
          [EventType.RoomName]: 100,
          [EventType.RoomMessage]: 0,
          [EventType.RoomMessageEncrypted]: 0,
          [EventType.Sticker]: 0,
          [EventType.SpaceChild]: 100,
          [EventType.SpaceParent]: 100,
          [UNSTABLE_MSC3089_BRANCH.name]: 100,
          [STORAGE_METADATA_EVENT_TYPE]: 100,
        },
        users: { [userId]: 100 },
      },
      creation_content: { [RoomCreateTypeField]: RoomType.Space },
      initial_state: [
        {
          type: UNSTABLE_MSC3088_PURPOSE.name,
          state_key: UNSTABLE_MSC3089_TREE_SUBTYPE.name,
          content: { [UNSTABLE_MSC3088_ENABLED.name]: true },
        },
        {
          type: EventType.RoomEncryption,
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    };
  }

  private async waitForTreeSpace(
    roomId: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<TreeSpace> {
    const deadline = Date.now() + TREE_SYNC_TIMEOUT_MS;
    let lastError: unknown;
    for (;;) {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      try {
        const tree = this.client.unstableGetFileTreeSpace(roomId) as unknown as TreeSpace | null;
        if (tree) return this.decorateTreeSpace(tree);
      } catch (error) {
        lastError = error;
        // The room can be present before its complete state has been applied
        // to this client's local store. Keep polling the exact returned ID.
      }
      if (Date.now() >= deadline) {
        throw new Error(`${operation}: created room did not become a file tree space in local sync state`, {
          cause: lastError,
        });
      }
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(new StorageError("operation cancelled"));
        };
        timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 100);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }

  /**
   * MSC3089's built-in createDirectory only sends the two relationship events;
   * it does not update either room's local state after the homeserver accepts
   * them. Wrap returned spaces so child creation goes through createSubtree,
   * which refreshes the exact parent/child state before reporting success.
   */
  private decorateTreeSpace(tree: TreeSpace): TreeSpace {
    if (this.decoratedTreeSpaces.has(tree as object)) return tree;
    this.decoratedTreeSpaces.add(tree as object);

    const originalGetDirectories = tree.getDirectories.bind(tree);
    const originalListFiles = typeof tree.listFiles === "function"
      ? tree.listFiles.bind(tree)
      : () => [];
    const originalGetFile = typeof tree.getFile === "function"
      ? tree.getFile.bind(tree)
      : () => null;
    tree.getDirectories = () =>
      originalGetDirectories().map((child) => this.decorateTreeSpace(child));
    tree.createDirectory = (name: string) => this.createSubtree(tree, name);
    tree.setName = (name: string) => this.writeTreeName(tree.id, name);
    tree.listFiles = () => originalListFiles().map((branch) => this.decorateFileBranch(tree.id, branch));
    tree.getFile = (fileId: string) => {
      const branch = originalGetFile(fileId);
      return branch ? this.decorateFileBranch(tree.id, branch) : null;
    };
    tree.createFile = (name, encryptedContents, info, additionalContent) =>
      this.createEncryptedFile(tree.id, name, encryptedContents, info, additionalContent);
    return tree;
  }

  private decorateFileBranch(treeId: string, branch: FileBranch): FileBranch {
    const existing = this.decoratedFileBranches.get(branch as object);
    if (existing) return existing;
    const decorated = Object.create(branch) as FileBranch;
    const nameKey = this.fileNameKey(treeId, branch.id);
    Object.defineProperties(decorated, {
      getName: {
        value: () => this.fileNames.get(nameKey) ?? GENERIC_FILE_NAME,
      },
      setName: {
        value: (name: string) => this.writeFileName(treeId, branch.id, name),
      },
      delete: {
        value: async () => {
          const { deleteFile } = await import("./core/operations.js");
          await deleteFile(this, treeId, branch.id);
        },
      },
    });
    this.decoratedFileBranches.set(branch as object, decorated);
    return decorated;
  }

  /** Cleans up only a room created by this operation and reports incomplete cleanup. */
  private async cleanupCreatedRoom(roomId: string): Promise<void> {
    // Cleanup is compensating work. It must not inherit the caller's already
    // aborted deadline, or a timed-out create could never even attempt leave.
    const cleanupSignal = new AbortController().signal;
    let safeToForget = true;
    const failures: unknown[] = [];
    try {
      await TeleCryptIOStorage.withTimeout(
        withMatrixMutationAbort(() => this.client.leave(roomId), cleanupSignal),
        CLEANUP_TIMEOUT_MS,
        "room leave cleanup",
        cleanupSignal,
      );
    } catch (error) {
      if (!isGoneRoomError(error)) {
        failures.push(error);
        // A timed-out or failed leave may still be in flight. Do not race a
        // forget request against it; the caller must retry cleanup later.
        safeToForget = false;
      }
    }
    if (safeToForget) {
      try {
        await TeleCryptIOStorage.withTimeout(
          withMatrixMutationAbort(() => this.client.forget(roomId), cleanupSignal),
          CLEANUP_TIMEOUT_MS,
          "room forget cleanup",
          cleanupSignal,
        );
      } catch (error) {
        if (!isGoneRoomError(error)) {
          failures.push(error);
        }
      }
    }
    if (failures.length > 0) {
      const cause = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "room cleanup failed");
      throw new RoomCleanupIncompleteError(roomId, cause);
    }
  }

  private async removeRelationLink(
    roomId: string,
    eventType: EventType,
    stateKey: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const room = this.client.getRoom(roomId);
    const raw = room?.currentState.getStateEvents(eventType, stateKey);
    const event = Array.isArray(raw) ? raw[0] : raw;
    if (!event) return false;
    // This path is used only after an ambiguous send without an event ID. A
    // state-key match alone is unsafe: another actor may have replaced the
    // relation while the failed send was in flight. Redact only an event whose
    // sender is provably this client; otherwise leave it in place and report
    // incomplete cleanup to the caller.
    const currentUserId = this.client.getUserId();
    const getSender = (event as { getSender?: () => string | null }).getSender;
    if (!currentUserId || typeof getSender !== "function" || getSender() !== currentUserId) return false;
    const eventId = validateMatrixEventId(event.getId(), "state event ID");
    await withMatrixMutationAbort(() => this.client.redactEvent(roomId, eventId), signal);
    return true;
  }

  private async removeChildLink(parentId: string, childId: string, signal?: AbortSignal): Promise<boolean> {
    return this.removeRelationLink(parentId, EventType.SpaceChild, childId, signal);
  }

  private async removeParentLink(childId: string, parentId: string, signal?: AbortSignal): Promise<boolean> {
    return this.removeRelationLink(childId, EventType.SpaceParent, parentId, signal);
  }

  private async createTreeSpace(
    name: string,
    operation: string,
    signal?: AbortSignal,
  ): Promise<TreeSpace> {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    const response = await TeleCryptIOStorage.withMutationTimeout(
      withMatrixMutationAbort(
        () => this.client.createRoom(this.treeRoomOptions(name)),
        signal,
        `${operation} room creation`,
      ),
      MATRIX_HTTP_TIMEOUT_MS,
      `${operation} room creation`,
    ).catch((error: unknown) => {
      // createRoom is a server-side mutation. A rejected HTTP promise does
      // not prove that the request was rejected before commit, so every
      // non-validation failure follows the reconciliation path instead of a
      // retryable generic error that could orphan a second room.
      if (error instanceof RoomCreationAmbiguousError) throw error;
      throw new RoomCreationAmbiguousError(operation, error);
    });
    let roomId: string;
    try {
      roomId = validateMatrixRoomId(
        (response as unknown as { room_id?: unknown } | undefined)?.room_id,
        "room creation response",
      );
    } catch (error) {
      throw new RoomCreationAmbiguousError(operation, error);
    }
    try {
      const tree = await this.waitForTreeSpace(roomId, operation, signal);
      try {
        await this.writeTreeName(roomId, name);
      } catch (error) {
        try {
          await this.cleanupCreatedRoom(roomId);
        } catch (cleanupError) {
          throwWithCleanupDetail(error, roomId, cleanupError);
        }
        throw new StorageError(`${operation}: encrypted name initialization failed`, { cause: error });
      }
      return tree;
    } catch (error) {
      if (
        error instanceof StorageError &&
        error.message === `${operation}: encrypted name initialization failed`
      ) {
        throw error;
      }
      try {
        await this.cleanupCreatedRoom(roomId);
      } catch (cleanupError) {
        throwWithCleanupDetail(error, roomId, cleanupError);
      }
      // The room existed even if cleanup happened to succeed. Keep the
      // caller on the reconciliation path: a retry based on a local timeout
      // or malformed response must never assume that no room was created.
      throw new RoomCreationAmbiguousError(operation, error);
    }
  }

  /**
   * Creates one top-level shared vault per invocation. Same-name calls are
   * serialized for this MatrixClient, but display names are not identities.
   */
  async createTree(name: string, signal?: AbortSignal): Promise<TreeSpace> {
    return withTreeMutation(
      this.client,
      (queuedSignal) => this.createTreeSpace(name, "createTree", queuedSignal),
      signal,
    );
  }

  async listTrees(signal?: AbortSignal): Promise<TreeSpace[]> {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    const rooms = this.client.getRooms();
    const trees: TreeSpace[] = [];
    for (const room of rooms) {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      if (isTreeDeleted(this.client, room.roomId)) continue;
      const tree = this.client.unstableGetFileTreeSpace(
        room.roomId,
      ) as unknown as TreeSpace | null;
      if (tree) trees.push(this.decorateTreeSpace(tree));
    }
    return trees;
  }

  /** Creates and links a child tree space using the exact Matrix room ID. */
  async createSubtree(
    parent: TreeSpace,
    name: string,
    signal?: AbortSignal,
  ): Promise<TreeSpace> {
    return withTreeMutation(this.client, async (queuedSignal) => {
      const effectiveSignal = queuedSignal ?? signal;
      await this.refreshRoomState(parent.id, { signal: effectiveSignal });
      const currentParent = this.getTree(parent.id);
      if (!currentParent) throw new Error("createSubtree: parent is unavailable");

      const tree = await this.createTreeSpace(name, "createSubtree", effectiveSignal);
      let parentLinkAttempted = false;
      let parentLinkEventId: string | undefined;
      let childLinkAttempted = false;
      let childLinkEventId: string | undefined;
      try {
        const via = this.client.getDomain();
        if (!via) throw new Error("createSubtree: Matrix client has no server domain");

        parentLinkAttempted = true;
        const parentLink = await TeleCryptIOStorage.withMutationTimeout(
          withMatrixMutationAbort(
            () =>
              this.client.sendStateEvent(
                currentParent.id,
                EventType.SpaceChild,
                { via: [via] },
                tree.id,
              ),
            effectiveSignal,
          ),
          MATRIX_HTTP_TIMEOUT_MS,
          "parent link",
        );
        if ((parentLink as { event_id?: unknown } | undefined)?.event_id !== undefined) {
          parentLinkEventId = validateMatrixEventId(
            (parentLink as { event_id?: unknown }).event_id,
            "parent link response event ID",
          );
        }
        childLinkAttempted = true;
        const childLink = await TeleCryptIOStorage.withMutationTimeout(
          withMatrixMutationAbort(
            () =>
              this.client.sendStateEvent(
                tree.id,
                EventType.SpaceParent,
                { via: [via] },
                currentParent.id,
              ),
            effectiveSignal,
          ),
          MATRIX_HTTP_TIMEOUT_MS,
          "child link",
        );
        if ((childLink as { event_id?: unknown } | undefined)?.event_id !== undefined) {
          childLinkEventId = validateMatrixEventId(
            (childLink as { event_id?: unknown }).event_id,
            "child link response event ID",
          );
        }
        // sendStateEvent resolves when the server accepts the event, not when
        // this client's sync loop has applied it. Refresh both exact rooms so
        // isTopLevel/getDirectories and recursive invites observe the link.
        await this.refreshRoomState(currentParent.id, { signal: effectiveSignal });
        if (this.client.getRoom(tree.id)) {
          await this.refreshRoomState(tree.id, { signal: effectiveSignal });
        }
        return tree;
      } catch (error) {
        // Compensation is independent of the caller's cancelled deadline.
        // Reconcile and retry these idempotent relation updates with a fresh
        // signal, then report incomplete cleanup if they cannot be verified.
        const compensationSignal = new AbortController().signal;
        const cleanupFailures: unknown[] = [];
        // A sendStateEvent rejection is ambiguous: the homeserver may have
        // committed the event before the client observed a transport error.
        // Refresh the parent before probing even when no event ID was
        // returned. A sendStateEvent rejection can race the sync loop, so the
        // pre-refresh local state is not authoritative. A missing link after
        // the refresh is the expected outcome for a rejection before commit.
        if (parentLinkAttempted) {
          try {
            if (parentLinkEventId) {
              await TeleCryptIOStorage.withTimeout(
                withMatrixMutationAbort(
                  () => this.client.redactEvent(currentParent.id, parentLinkEventId!),
                  compensationSignal,
                ),
                MATRIX_HTTP_TIMEOUT_MS,
                "parent link rollback",
                compensationSignal,
              );
              await this.refreshRoomState(currentParent.id, { signal: compensationSignal });
              const remaining = this.client
                .getRoom(currentParent.id)
                ?.currentState.getStateEvents(EventType.SpaceChild, tree.id);
              if (
                remaining &&
                (Array.isArray(remaining) ? remaining : [remaining]).some((event) => {
                  const content = event.getContent?.();
                  return (
                    typeof content === "object" &&
                    content !== null &&
                    !Array.isArray(content) &&
                    Object.keys(content).length > 0
                  );
                })
              ) {
                cleanupFailures.push(new Error("parent link rollback could not be verified"));
              }
            } else {
              await this.refreshRoomState(currentParent.id, { signal: compensationSignal });
              const removed = await this.removeChildLink(currentParent.id, tree.id, compensationSignal);
              // Without an event ID, a missing link after one refresh does not
              // prove that a request which timed out will never commit.
              if (!removed) {
                cleanupFailures.push(new Error("parent link rollback could not be verified"));
              }
            }
          } catch (cleanupError) {
            cleanupFailures.push(cleanupError);
          }
        }
        if (childLinkAttempted) {
          try {
            if (childLinkEventId) {
              await TeleCryptIOStorage.withTimeout(
                withMatrixMutationAbort(
                  () => this.client.redactEvent(tree.id, childLinkEventId!),
                  compensationSignal,
                ),
                MATRIX_HTTP_TIMEOUT_MS,
                "child link rollback",
                compensationSignal,
              );
              await this.refreshRoomState(tree.id, { signal: compensationSignal });
              const remaining = this.client
                .getRoom(tree.id)
                ?.currentState.getStateEvents(EventType.SpaceParent, currentParent.id);
              if (
                remaining &&
                (Array.isArray(remaining) ? remaining : [remaining]).some((event) => {
                  const content = event.getContent?.();
                  return (
                    typeof content === "object" &&
                    content !== null &&
                    !Array.isArray(content) &&
                    Object.keys(content).length > 0
                  );
                })
              ) {
                cleanupFailures.push(new Error("child link rollback could not be verified"));
              }
            } else {
              await this.refreshRoomState(tree.id, { signal: compensationSignal });
              const removed = await this.removeParentLink(tree.id, currentParent.id, compensationSignal);
              if (!removed) {
                cleanupFailures.push(new Error("child link rollback could not be verified"));
              }
            }
          } catch (cleanupError) {
            cleanupFailures.push(cleanupError);
          }
        }
        try {
          await this.cleanupCreatedRoom(tree.id);
        } catch (cleanupError) {
          cleanupFailures.push(cleanupError);
        }
        if (cleanupFailures.length > 0) {
          const cleanupCause = cleanupFailures.length === 1
            ? cleanupFailures[0]
            : new AggregateError(cleanupFailures, "tree creation cleanup failed");
          throwWithCleanupDetail(error, tree.id, cleanupCause);
        }
        throw error;
      }
    }, signal);
  }

  getTree(roomId: string): TreeSpace | null {
    if (isTreeDeleted(this.client, roomId)) return null;
    const tree = this.client.unstableGetFileTreeSpace(
      roomId,
    ) as unknown as TreeSpace | null;
    return tree ? this.decorateTreeSpace(tree) : null;
  }

  /**
   * Lists the participants of a shared vault (tree space) and their role,
   * derived from room membership (join/invite state) + power levels.
   * Includes invited-but-not-yet-joined members as well as joined ones;
   * excludes anyone who has left/been kicked/banned.
   *
   * Deliberately reads directly from the server's authoritative REST state
   * endpoints (`GET .../members`, `GET .../state/m.room.power_levels/`)
   * rather than from the client's locally synced `tree.room`/`currentState`.
   * On a freshly-started client (as every CLI command is), room membership and
   * power-level state can take several more `/sync` round trips to fully
   * converge locally after a change, even though the room itself is already
   * visible — reading the same data straight from the server sidesteps that
   * sync-convergence lag entirely. The role thresholds mirror
   * `MSC3089TreeSpace.getPermissions()` exactly (userLevel >= adminLevel ->
   * owner, >= editLevel -> editor, else viewer).
   */
  async listMembers(
    tree: TreeSpace,
    options?: MatrixRequestOptions,
  ): Promise<{ userId: string; role: string; membership: string }[]> {
    const roomId = encodeURIComponent(tree.id);
    const membersPath = `/rooms/${roomId}/members`;
    const powerLevelsPath = `/rooms/${roomId}/state/m.room.power_levels/`;
    const reqOpts = {
      prefix: ClientPrefix.V3,
      localTimeoutMs: matrixRequestTimeout(options),
      abortSignal: matrixRequestSignal(options),
    };

    const http = requireMatrixHttpTransport(this.client);
    const [membersBody, plsRaw] = await Promise.all([
      http.authedRequest<{
        chunk: MatrixMemberEntry[];
      }>(Method.Get, membersPath, undefined, undefined, reqOpts),
      http.authedRequest<MatrixPowerLevels>(
        Method.Get,
        powerLevelsPath,
        undefined,
        undefined,
        reqOpts,
      ),
    ]);
    const members = parseMatrixMembersResponse(membersBody);
    const pls = parseMatrixPowerLevels(plsRaw);

    const viewLevel = pls.users_default ?? 0;
    const editLevel = pls.events_default ?? 50;
    const adminLevel = pls.events?.["m.room.power_levels"] ?? 100;
    const roleFor = (userId: string): string => {
      const userLevel = pls.users?.[userId] ?? viewLevel;
      if (userLevel >= adminLevel) return "owner";
      if (userLevel >= editLevel) return "editor";
      return "viewer";
    };

    return members
      .filter(
        (e) =>
          e.content.membership === "join" ||
          e.content.membership === "invite" ||
          e.content.membership === "knock",
      )
      .map((e) => ({
        userId: e.state_key,
        membership: e.content.membership as string,
        role: roleFor(e.state_key),
      }));
  }

  /** Reads one room membership from the homeserver, not the lagging local sync store. */
  async getRoomMembership(
    roomId: string,
    userId = this.client.getUserId(),
    options?: MatrixRequestOptions,
  ): Promise<string | null> {
    if (!userId) return null;
    const body = await requireMatrixHttpTransport(this.client).authedRequest<{ chunk: MatrixMemberEntry[] }>(
      Method.Get,
      `/rooms/${encodeURIComponent(roomId)}/members`,
      undefined,
      undefined,
      {
        prefix: ClientPrefix.V3,
        localTimeoutMs: matrixRequestTimeout(options),
        abortSignal: matrixRequestSignal(options),
      },
    );
    const member = parseMatrixMembersResponse(body).find((entry) => entry.state_key === userId);
    return member?.content.membership ?? null;
  }

  async uploadFile(
    tree: TreeSpace,
    name: string,
    data: ArrayBuffer,
    mimetype: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    validateFileName(name);
    validateMimetype(mimetype);
    if (data.byteLength > MAX_MEDIA_FILE_BYTES) throw new FileTooLargeError();
    const encrypted = await encryptAttachment(data);
    if (signal?.aborted) throw new StorageError("operation cancelled");
    let response: { event_id?: unknown };
    try {
      response = await withMatrixMutationAbort(
        () =>
          tree.createFile(
            name,
            new Uint8Array(encrypted.data),
            encrypted.info as unknown as Record<string, unknown>,
            { info: { mimetype, size: data.byteLength } },
          ),
        signal,
        "file upload",
      );
    } catch (error) {
      // A transport failure after the encrypted event was submitted cannot be
      // distinguished from a failure before commit. Do not let a caller retry
      // this operation and create a duplicate file; only the explicit typed
      // mutation outcome is safe to propagate unchanged.
      if (error instanceof MutationOutcomeUnknownError) throw error;
      throw new MutationOutcomeUnknownError("file upload", { cause: error });
    }
    if (signal?.aborted) throw new StorageError("operation cancelled");
    try {
      return validateMatrixEventId(response?.event_id, "file upload response event ID");
    } catch (error) {
      // An invalid response can still follow a committed event. Treat it as
      // unknown rather than presenting a retryable generic upload failure.
      throw new MutationOutcomeUnknownError("file upload", { cause: error });
    }
  }

  async downloadFile(
    branch: FileBranch,
    signal?: AbortSignal,
  ): Promise<{ data: ArrayBuffer; mimetype: string }> {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    let info: Record<string, unknown> | undefined;
    let fileEvent: MatrixEvent | undefined;
    try {
      fileEvent = await this.getOriginalFileEvent(branch.roomId, branch.id);
      const content = fileEvent.getContent();
      info = isRecord(content) && isRecord(content.file) ? content.file : undefined;
    } catch (error) {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      if (error instanceof StorageError || error instanceof MatrixError) throw error;
      throw error;
    }
    // Missing metadata alone does not establish a decryption failure.
    if (!info || typeof info.url !== "string") {
      throw new StorageError("file metadata is missing a media URL");
    }
    // `info` is the encrypted attachment descriptor. Its shape is owned by
    // matrix-encrypt-attachment and does not carry the plaintext size. The
    // event's `info` block is the sole source of user-facing file metadata.
    const eventMetadata = readFileEventMetadata(fileEvent!.getContent());
    if (signal?.aborted) throw new StorageError("operation cancelled");
    const declaredSize = eventMetadata.size;
    const mimetype = eventMetadata.mimetype ?? "application/octet-stream";
    const mxcUrl = info.url;
    const clientAny = this.client as unknown as {
      mxcUrlToHttp: (
        mxc: string,
        ...args: unknown[]
      ) => string | null;
      getAccessToken: () => string | null;
      getHomeserverUrl: () => string;
    };
    const accessToken = clientAny.getAccessToken();
    validateMatrixToken(accessToken);
    let trustedOrigin: string;
    try {
      trustedOrigin = validateHomeserverUrl(clientAny.getHomeserverUrl()).origin;
    } catch (error) {
      throw new Error("failed to build media URL", { cause: error });
    }
    const downloadUrl = clientAny.mxcUrlToHttp(
      mxcUrl,
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    );
    if (!downloadUrl) throw new Error("failed to build media URL");

    let currentUrl: URL;
    try {
      currentUrl = new URL(downloadUrl);
    } catch (error) {
      throw new Error("failed to build media URL", { cause: error });
    }
    if (
      (currentUrl.protocol !== "http:" && currentUrl.protocol !== "https:") ||
      currentUrl.username !== "" ||
      currentUrl.password !== ""
    ) {
      throw new Error("failed to build media URL");
    }
    if (currentUrl.origin !== trustedOrigin) throw new Error("media download origin is untrusted");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
    const abortExternal = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) abortExternal();
    else signal?.addEventListener("abort", abortExternal, { once: true });
    let ciphertext: ArrayBuffer;
    try {
      for (;;) {
        const res = await raceWithAbort(
          fetch(currentUrl, {
            redirect: "manual",
            signal: controller.signal,
            headers: { Authorization: `Bearer ${accessToken}` },
          }),
          controller.signal,
          () =>
            signal?.aborted
              ? new StorageError("operation cancelled")
              : new Error("media download timed out"),
        );
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          let redirectError: Error | undefined;
          let nextUrl: URL | undefined;
          const location = res.headers.get("location");
          if (!location) {
            redirectError = new Error("media download redirect missing location");
          } else {
            try {
              nextUrl = new URL(location, currentUrl);
            } catch (error) {
              redirectError = new Error("media download redirect is invalid", { cause: error });
            }
            if (
              nextUrl &&
              ((nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") ||
                nextUrl.username !== "" ||
                nextUrl.password !== "")
            ) {
              redirectError = new Error("media download redirect is invalid");
            }
            if (nextUrl && nextUrl.origin !== trustedOrigin) {
              redirectError = new Error("media download redirect crossed origin");
            }
          }
          cancelResponseBody(res);
          if (redirectError) throw redirectError;
          currentUrl = nextUrl!;
          continue;
        }
        if (!res.ok) {
          const statusFailure = new Error(`media download failed: ${res.status}`);
          let detail = "";
          try {
            // Error responses are diagnostics, not product media. Consume the
            // complete body so no provider detail is discarded, then apply
            // the SDK's shared secret/control-character sanitizer before it
            // crosses the SDK boundary.
            const body = await readResponseBody(res, controller.signal);
            detail = sanitizeDiagnosticText(new TextDecoder().decode(body.bytes));
          } catch (bodyError) {
            const partial =
              bodyError instanceof ResponseBodyReadError
                ? sanitizeDiagnosticText(new TextDecoder().decode(bodyError.bytes))
                : "";
            const readFailure =
              bodyError instanceof ResponseBodyReadError
                ? new Error(
                    `media error response body could not be read${partial === "" ? "" : `: ${partial}`}`,
                    { cause: bodyError },
                  )
                : bodyError;
            throw new AggregateError(
              [statusFailure, readFailure],
              "media download failed while reading the response body",
              { cause: statusFailure },
            );
          }
          throw new Error(`${statusFailure.message}${detail === "" ? "" : `: ${detail}`}`);
        }
        if (!res.body) {
          throw new Error("media download has no response body");
        }
        const body = await readMediaResponseBody(res, MAX_MEDIA_FILE_BYTES, controller.signal);
        ciphertext = body.bytes.buffer;
        break;
      }
    } catch (error) {
      if (error instanceof AggregateError) {
        if (signal?.aborted) throw new StorageError("operation cancelled", { cause: error });
        if (controller.signal.aborted) throw new Error("media download timed out", { cause: error });
        throw error;
      }
      if (error instanceof ResponseBodyReadError) {
        throw new Error("media download failed", { cause: error.cause ?? new Error(error.message) });
      }
      if (signal?.aborted) throw new StorageError("operation cancelled", { cause: error });
      if (controller.signal.aborted) throw new Error("media download timed out", { cause: error });
      if (error instanceof FileTooLargeError) throw error;
      throw new Error("media download failed", { cause: error });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortExternal);
    }
    let data: ArrayBuffer;
    try {
      data = await decryptAttachment(
        ciphertext,
        info as unknown as Parameters<typeof decryptAttachment>[1],
      );
    } catch (error) {
      if (error instanceof FileTooLargeError) throw error;
      throw new Error("media decryption failed", { cause: error });
    }
    if (data.byteLength > MAX_MEDIA_FILE_BYTES) throw new FileTooLargeError();
    if (signal?.aborted) throw new StorageError("operation cancelled");
    if (declaredSize !== null && data.byteLength !== declaredSize) {
      throw new StorageError("media metadata size does not match decrypted file");
    }
    if (signal?.aborted) throw new StorageError("operation cancelled");
    return { data, mimetype };
  }
}
