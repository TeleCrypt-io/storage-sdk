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
import {
  EventShieldReason,
  OnlySignedDevicesIsolationMode,
} from "matrix-js-sdk/lib/crypto-api/index.js";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import { ClientPrefix } from "matrix-js-sdk/lib/http-api/prefix.js";
import { DEFAULT_TREE_POWER_LEVELS_TEMPLATE } from "matrix-js-sdk/lib/models/MSC3089TreeSpace.js";
import { encryptAttachment, decryptAttachment } from "matrix-encrypt-attachment";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api/index.js";
import type { TokenRefreshFunction } from "matrix-js-sdk/lib/http-api/index.js";
import {
  FileTooLargeError,
  MutationOutcomeUnknownError,
  MutationPartialError,
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
import {
  isStorageTreeRoom,
  STORAGE_ROOM_ENCRYPTION_ALGORITHM,
  validateName,
} from "./core/validation.js";
import { ConditionTimeoutError, waitForCondition } from "./core/poll.js";
import { isTreeDeleted } from "./deletion-markers.js";
import { DecryptionKeySafe, type KeySafePersistenceOptions } from "./key-safe.js";
import { prepareReaderHistorySharing } from "./sharing.js";
import { deleteOwnedMedia } from "./media.js";

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
    signal?: AbortSignal,
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
   * restart recovery and (via `keySafe.setup`/`keySafe.restore`)
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
  /** Persist local Key Safe state before server-side setup continues (CLI snapshots). */
  onKeySafeStateChanged?: () => Promise<void>;
  /** initialSyncLimit passed to startClient(); default 10. */
  initialSyncLimit?: number;
  /** Start Matrix sync after crypto initializes; default true. */
  startClient?: boolean;
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
   * storage key from an OS keychain instead of prompting). `keySafe.setup`
   * and `keySafe.restore` temporarily override
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
  /** Persist local Key Safe state before server-side setup continues (CLI snapshots). */
  onKeySafeStateChanged?: () => Promise<void>;
  initialSyncLimit?: number;
  startClient?: boolean;
  syncTimeoutMs?: number;
  initTimeoutMs?: number;
  onProgress?: (message: string) => void;
  /** Cancels bootstrap and stops the owned MatrixClient before rejecting. */
  signal?: AbortSignal;
  cryptoCallbacks?: CryptoCallbacks;
}

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
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await fetchFn(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return readMatrixResponse(response, signal);
  }) as typeof fetch;
  return wrapped;
}

export interface MatrixRequestOptions {
  signal?: AbortSignal;
  metadataEventId?: string;
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
    query?: unknown,
    body?: unknown,
    options?: MatrixRequestOptions & { prefix?: string },
  ) => Promise<T>;
}

const metadataRequestSignals = new WeakMap<MatrixClient, Map<string, AbortSignal>>();
const metadataSchedulers = new WeakMap<NonNullable<MatrixClient["scheduler"]>, Map<string, AbortSignal>>();

/** Matrix's encrypted send API accepts a transaction ID but no request signal.
 * Attach the caller's signal only to that native transaction's HTTP request. */
function registerMetadataRequest(client: MatrixClient, transactionId: string, signal: AbortSignal): () => void {
  let signals = metadataRequestSignals.get(client);
  if (!signals) {
    signals = new Map();
    const transport = requireMatrixHttpTransport(client);
    const original = transport.authedRequest.bind(transport);
    const registered = signals;
    transport.authedRequest = (method, path, query, body, options) => {
      const key = path.split("/").at(-1);
      const requestSignal = key ? registered.get(decodeURIComponent(key)) : undefined;
      return original(method, path, query, body,
        requestSignal ? { ...options, abortSignal: requestSignal, localTimeoutMs: MATRIX_HTTP_TIMEOUT_MS } : options);
    };
    metadataRequestSignals.set(client, signals);
  }
  const scheduler = client.scheduler;
  let queuedSignals = scheduler && metadataSchedulers.get(scheduler);
  if (scheduler && !queuedSignals) {
    queuedSignals = new Map();
    const registered = queuedSignals;
    const queueEvent = scheduler.queueEvent.bind(scheduler);
    scheduler.queueEvent = (event) => {
      const pending = queueEvent(event);
      const transaction = event.getTxnId();
      const requestSignal = transaction ? registered.get(transaction) : undefined;
      if (!pending || !requestSignal) return pending;
      return new Promise((resolve, reject) => {
        const abort = () => {
          const queue = scheduler.getQueueForEvent(event);
          if (queue && queue.findIndex((candidate) => candidate.getId() === event.getId()) > 0 &&
              scheduler.removeEventFromQueue(event)) {
            requestSignal.removeEventListener("abort", abort);
            reject(new StorageError("operation cancelled"));
          }
        };
        requestSignal.addEventListener("abort", abort, { once: true });
        if (requestSignal.aborted) queueMicrotask(abort);
        pending.then(resolve, reject).finally(() => requestSignal.removeEventListener("abort", abort));
      });
    };
    metadataSchedulers.set(scheduler, queuedSignals);
  }
  signals.set(transactionId, signal);
  queuedSignals?.set(transactionId, signal);
  return () => { signals.delete(transactionId); queuedSignals?.delete(transactionId); };
}

function matrixRequestTimeout(options?: MatrixRequestOptions): number | undefined {
  const value = options?.timeoutMs ?? options?.localTimeoutMs;
  if (value === undefined) return undefined;
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
  invite?: number;
  kick?: number;
  ban?: number;
  redact?: number;
  state_default?: number;
  users_default?: number;
  events_default?: number;
  events?: Record<string, number>;
  users?: Record<string, number>;
}

interface SecretStorageStatusShape {
  defaultKeyId: string | null;
  ready: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSecretStorageStatus(value: unknown): SecretStorageStatusShape {
  if (!isRecord(value)) throw new StorageError("secret-storage status is unavailable or invalid");
  const defaultKeyId = value.defaultKeyId;
  if (defaultKeyId !== null && (typeof defaultKeyId !== "string" || defaultKeyId.length === 0)) {
    throw new StorageError("secret-storage status is unavailable or invalid");
  }
  if (typeof value.ready !== "boolean") throw new StorageError("secret-storage status is unavailable or invalid");
  return { defaultKeyId, ready: value.ready };
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
    if (new TextEncoder().encode(event.state_key).byteLength > MAX_MATRIX_IDENTIFIER_BYTES) {
      throw new Error("invalid Matrix state event key");
    }
    return event;
  });
}

function parseMatrixPowerLevels(value: unknown): MatrixPowerLevels {
  if (!isRecord(value)) throw new Error("invalid Matrix power-level response");
  for (const name of ["invite", "kick", "ban", "redact", "users_default", "events_default", "state_default"]) {
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

function convertKnownLegacyTreePowerLevels(value: unknown): MatrixPowerLevels | null {
  const levels = parseMatrixPowerLevels(value);
  if (!levels.users || !levels.events) return null;
  const oldDefaults: Record<string, number> = {
    invite: 100,
    kick: 100,
    ban: 100,
    redact: 100,
    state_default: 100,
    events_default: 0,
    users_default: 0,
  };
  if (Object.entries(oldDefaults).some(([key, expected]) => (levels as Record<string, unknown>)[key] !== expected)) {
    return null;
  }
  const oldEvents: Record<string, number> = {
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
  };
  const repairedEvents = new Set<string>([EventType.RoomJoinRules, UNSTABLE_MSC3088_PURPOSE.name]);
  if (
    Object.entries(oldEvents).some(([key, expected]) => levels.events?.[key] !== expected) ||
    Object.entries(levels.events).some(([key, level]) =>
      !Object.hasOwn(oldEvents, key) && !(repairedEvents.has(key) && level === 100),
    )
  ) {
    return null;
  }

  const events: Record<string, number> = {
    ...levels.events,
    ...DEFAULT_TREE_POWER_LEVELS_TEMPLATE.events,
    [EventType.SpaceChild]: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.events_default,
    [EventType.SpaceParent]: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.events_default,
    [UNSTABLE_MSC3089_BRANCH.name]: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.events_default,
    [STORAGE_METADATA_EVENT_TYPE]: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.events_default,
  };
  delete events[EventType.RoomJoinRules];
  delete events[UNSTABLE_MSC3088_PURPOSE.name];
  return {
    ...levels,
    invite: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.invite,
    kick: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.kick,
    ban: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.ban,
    redact: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.redact,
    state_default: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.state_default,
    events_default: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.events_default,
    users_default: DEFAULT_TREE_POWER_LEVELS_TEMPLATE.users_default,
    events,
  };
}

function isGoneRoomError(error: unknown): boolean {
  return error instanceof MatrixError && error.httpStatus === 404 && error.errcode === "M_NOT_FOUND";
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
  let started = false;
  const run = previous.catch(() => undefined).then(() => {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    started = true;
    return operation(signal);
  });
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  treeMutationQueues.set(client, settled);
  if (!signal) return run;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { if (!started) reject(new StorageError("operation cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    run.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class TeleCryptIOStorage {
  private readonly decoratedTreeSpaces = new WeakSet<object>();
  private readonly decoratedFileBranches = new WeakMap<object, FileBranch>();
  private readonly treeNames = new Map<string, string>();
  private readonly fileNames = new Map<string, string>();

  readonly keySafe: DecryptionKeySafe;
  private syncStarted = false;
  private syncInFlight: Promise<void> | undefined;

  constructor(
    private client: MatrixClient,
    options: KeySafePersistenceOptions = {},
    private readonly syncOptions: Pick<CreateTeleCryptIOStorageOptions, "initialSyncLimit" | "syncTimeoutMs" | "onProgress"> = {},
  ) {
    this.keySafe = new DecryptionKeySafe(
      client,
      (key, operation, signal) => this.withSecretStorageKey(key, operation, signal),
      options,
      (signal) => this.startSync(signal),
    );
    // Advanced callers may construct a MatrixClient themselves. Configure it
    // with the supported createClient({ fetchFn }) option, or use
    // TeleCryptIOStorage.create()/createFromOidc().
  }

  /** The underlying matrix-js-sdk client (e.g. to stop it, or for advanced/interop use). */
  getClient(): MatrixClient {
    return this.client;
  }

  /** Start Matrix room sync after crypto setup, for example after the current
   * login has checked or restored its Decryption Key Safe. */
  async startSync(signal?: AbortSignal): Promise<void> {
    if (this.syncStarted) return;
    if (this.syncInFlight) return this.syncInFlight;
    const start = (async () => {
      try {
        TeleCryptIOStorage.throwIfAborted(signal);
        const timeoutMs = this.syncOptions.syncTimeoutMs ?? 15000;
        this.syncOptions.onProgress?.("Starting Matrix client…");
        await TeleCryptIOStorage.withTimeout(
          this.client.startClient({ initialSyncLimit: this.syncOptions.initialSyncLimit ?? 10 }),
          timeoutMs,
          "client start",
          signal,
        );
        this.syncOptions.onProgress?.("Waiting for first sync with homeserver…");
        await TeleCryptIOStorage.waitForFirstSync(this.client, timeoutMs, signal);
        TeleCryptIOStorage.throwIfAborted(signal);
        this.syncStarted = true;
        this.syncOptions.onProgress?.("Sync complete.");
      } catch (error) {
        try {
          this.client.stopClient();
        } catch (stopError) {
          throw new AggregateError([error, stopError], "Matrix sync startup and cleanup failed");
        }
        throw error;
      } finally {
        this.syncInFlight = undefined;
      }
    })();
    this.syncInFlight = start;
    return start;
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

  /** Converts the former fixed-owner template only when an explicit role change targets the room. */
  async prepareTreePermissionsForAccessChange(
    roomId: string,
    options?: MatrixRequestOptions,
  ): Promise<void> {
    const current = this.getStateEvent(roomId, EventType.RoomPowerLevels, "")?.getContent();
    if (!current) return;
    const converted = convertKnownLegacyTreePowerLevels(current);
    if (!converted) return;
    await withMatrixMutationAbort(
      () => this.client.sendStateEvent(roomId, EventType.RoomPowerLevels, converted as never, ""),
      matrixRequestSignal(options),
    );
    await this.refreshRoomState(roomId, options);
  }

  private async sendEncryptedMetadataMessage(
    roomId: string,
    content: MetadataEventContent,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.refreshRoomState(roomId, { signal });
    this.requireEncryptedStorageRoom(roomId);
    if (signal?.aborted) throw new StorageError("operation cancelled");
    const transactionId = signal ? this.client.makeTxnId() : undefined;
    const unregister = signal && transactionId ? registerMetadataRequest(this.client, transactionId, signal) : undefined;
    let pending: ReturnType<MatrixClient["sendMessage"]>;
    try {
      pending = this.client.sendMessage(roomId, content as never, transactionId);
    } catch (error) {
      unregister?.();
      throw error;
    }
    let response: Awaited<typeof pending>;
    try {
      // Native encryption and the scheduler can still be working after abort.
      // Keep the transaction registered and wait for that exact send to settle;
      // a late successful response is an acknowledgement that must survive.
      response = await pending;
    } catch (error) {
      if (signal?.aborted) throw new MutationOutcomeUnknownError("encrypted metadata write", { cause: error });
      throw error;
    } finally {
      unregister?.();
    }
    return validateMatrixEventId(
      (response as unknown as { event_id?: unknown } | undefined)?.event_id,
      "storage metadata response event ID",
    );
  }

  private requireEncryptedStorageRoom(roomId: string): void {
    if (!isStorageTreeRoom(this.client.getRoom(roomId))) {
      throw new StorageError("storage room encryption is unavailable or unsupported");
    }
  }

  private async readEncryptedMetadataMessage(
    roomId: string,
    eventId: string,
    allowRedacted = false,
    signal?: AbortSignal,
  ): Promise<MatrixEvent> {
    const rawEvent = signal
      ? await requireMatrixHttpTransport(this.client).authedRequest<Awaited<ReturnType<MatrixClient["fetchRoomEvent"]>>>(
        Method.Get, `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
        undefined, undefined, { prefix: ClientPrefix.V3, abortSignal: signal },
      )
      : await this.client.fetchRoomEvent(roomId, eventId);
    const event = this.client.getEventMapper()(rawEvent);
    if (
      event.getId() !== eventId ||
      event.getRoomId() !== roomId ||
      !event.getSender() ||
      event.getWireType() !== EventType.RoomMessageEncrypted
    ) {
      throw new StorageError("encrypted storage metadata is invalid or unavailable");
    }
    if (allowRedacted && event.isRedacted()) return event;
    await this.client.decryptEventIfNeeded(event);
    if (event.isDecryptionFailure()) throw new UndecryptableFileError();
    if (event.getType() !== EventType.RoomMessage) {
      throw new StorageError("encrypted storage metadata is invalid or unavailable");
    }

    const crypto = this.client.getCrypto();
    if (!crypto) throw new StorageError("encryption is not initialized");
    const encryptionInfo = await crypto.getEncryptionInfoForEvent(event);
    if (!encryptionInfo || encryptionInfo.shieldReason === EventShieldReason.MISMATCHED_SENDER) {
      throw new UndecryptableFileError();
    }
    return event;
  }

  private async writeTreeName(roomId: string, name: string, signal?: AbortSignal, onMetadata?: (eventId: string) => void): Promise<void> {
    validateName(name, "name");
    const metadataEventId = await this.sendEncryptedMetadataMessage(roomId, {
      msgtype: STORAGE_METADATA_MSGTYPE,
      body: name,
    }, signal);
    onMetadata?.(metadataEventId);
    try {
      await this.client.sendStateEvent(
        roomId,
        STORAGE_METADATA_EVENT_TYPE as never,
        { event_id: metadataEventId } as never,
        "",
        { abortSignal: signal },
      );
    } catch (error) {
      throw new MutationPartialError("rename tree", [metadataEventId],
        "the encrypted name was accepted but its pointer could not be written",
        { cause: error, treeId: roomId, backupTargets: [{ treeId: roomId, metadataEventId }] });
    }
    this.treeNames.set(roomId, name);
  }

  private async getTreeMetadataEvent(roomId: string, options?: MatrixRequestOptions): Promise<MatrixEvent> {
    if (options?.signal?.aborted) throw new StorageError("operation cancelled");
    await this.refreshRoomState(roomId, options);
    const pointer = this.getStateEvent(roomId, STORAGE_METADATA_EVENT_TYPE, "");
    const pointerContent = pointer?.getContent();
    if (
      !pointer ||
      !pointer.getSender() ||
      !isRecord(pointerContent) ||
      typeof pointerContent.event_id !== "string"
    ) {
      throw new StorageError("encrypted storage name is unavailable");
    }
    const metadataEventId = validateMatrixEventId(pointerContent.event_id, "storage metadata event ID");
    const event = await this.readEncryptedMetadataMessage(roomId, metadataEventId, false, matrixRequestSignal(options));
    if (event.getSender() !== pointer.getSender()) {
      throw new StorageError("encrypted storage name author does not match its pointer");
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
    return event;
  }

  /** Resolves an encrypted vault/folder name through its pointer state event. */
  async getTreeName(roomId: string, options?: MatrixRequestOptions): Promise<string> {
    let event: MatrixEvent;
    try {
      event = await this.getTreeMetadataEvent(roomId, options);
    } catch (error) {
      // A new device can list storage before restoring room keys. Keep the
      // room visible with a generic label; a later call retries decryption.
      if (error instanceof UndecryptableFileError) return GENERIC_TREE_NAME;
      throw error;
    }
    const content = event.getContent();
    this.treeNames.set(roomId, content.body);
    return content.body;
  }

  /**
   * Waits for the current encrypted vault/folder name, or file metadata, to
   * have its session in the active native key backup. Checks the exact session
   * even when encryption reuses a key and the backup engine emits no new event.
   */
  async waitForKeyBackup(
    treeId: string,
    fileId?: string,
    options?: MatrixRequestOptions,
  ): Promise<"backed_up" | "deleted"> {
    validateMatrixRoomId(treeId);
    if (fileId !== undefined) validateMatrixEventId(fileId, "file event ID");
    if (options?.metadataEventId !== undefined) validateMatrixEventId(options.metadataEventId, "metadata event ID");
    const timeoutMs = matrixRequestTimeout({ timeoutMs: options?.timeoutMs ?? options?.localTimeoutMs ?? 20_000 });
    const signal = matrixRequestSignal(options);
    const crypto = this.client.getCrypto();
    if (!crypto) throw new StorageError("crypto is not initialized");
    let sessionIds: Set<string> | undefined;
    let deleted = false;
    try {
      await waitForCondition(async (signal) => {
        if (fileId !== undefined) {
          const state = await this.getOriginalFileEventState(treeId, fileId);
          if (state.redacted) {
            deleted = true;
            return true;
          }
        }
        if (!sessionIds) {
          const events: MatrixEvent[] = [];
          if (options?.metadataEventId) {
            events.push(await this.readEncryptedMetadataMessage(treeId, options.metadataEventId, true, signal));
          }
          if (fileId === undefined) {
            events.push(await this.getTreeMetadataEvent(treeId));
          } else {
            // The attachment contains the file key; a later rename may use a
            // different session. Both must be recoverable.
            events.push(await this.getOriginalFileEvent(treeId, fileId));
            const metadataId = await this.getFileMetadataEventId(treeId, fileId, { signal });
            if (metadataId && metadataId !== fileId) {
              events.push(await this.getFileRenameMetadataEvent(treeId, fileId, metadataId));
            }
          }
          sessionIds = new Set();
          for (const event of events) {
            const wire = event.getWireContent();
            if (event.isRedacted() || event.isDecryptionFailure() ||
              wire.algorithm !== STORAGE_ROOM_ENCRYPTION_ALGORITHM || typeof wire.session_id !== "string" || !wire.session_id) {
              throw new StorageError("encrypted storage session is unavailable");
            }
            sessionIds.add(wire.session_id);
          }
        }
        if (signal?.aborted) throw new StorageError("operation cancelled");
        const version = await crypto.getActiveSessionBackupVersion();
        if (!version) return null;
        for (const sessionId of sessionIds) {
          let backup: unknown;
          try {
            backup = await this.client.http.authedRequest<unknown>(
              Method.Get,
              `/room_keys/keys/${encodeURIComponent(treeId)}/${encodeURIComponent(sessionId)}`,
              { version },
              undefined,
              { prefix: ClientPrefix.V3, abortSignal: signal },
            );
          } catch (error) {
            if (error instanceof MatrixError && error.httpStatus === 404 && error.errcode === "M_NOT_FOUND") return null;
            throw error;
          }
          const sessionData = isRecord(backup) ? backup.session_data : undefined;
          if (!isRecord(backup) || !Number.isSafeInteger(backup.first_message_index) ||
            (backup.first_message_index as number) < 0 || !isRecord(sessionData) ||
            ["ciphertext", "ephemeral", "mac"].some((key) => typeof sessionData[key] !== "string" || !sessionData[key])) {
            throw new StorageError("server key backup session is invalid");
          }
        }
        return true;
      }, { timeoutMs, signal });
    } catch (error) {
      if (signal?.aborted) throw new StorageError("operation cancelled", { cause: error });
      if (error instanceof ConditionTimeoutError) {
        throw new StorageError("key backup did not settle before timeout; retry key backup", { cause: error });
      }
      throw error;
    }
    if (fileId !== undefined && !deleted) {
      deleted = (await this.getOriginalFileEventState(treeId, fileId)).redacted;
    }
    return deleted ? "deleted" : "backed_up";
  }

  private async writeFileName(treeId: string, fileId: string, name: string, signal?: AbortSignal, onMetadata?: (eventId: string) => void): Promise<void> {
    validateName(name, "file name");
    validateMatrixEventId(fileId, "file event ID");
    await this.refreshRoomState(treeId, { signal });
    this.requireEncryptedStorageRoom(treeId);
    const branch = this.getTree(treeId)?.getFile(fileId);
    const indexEvent = branch?.indexEvent;
    const indexContent = indexEvent?.getContent();
    if (
      !branch ||
      branch.isActive === false ||
      !indexEvent ||
      indexEvent.isRedacted() ||
      !indexEvent.getSender() ||
      !isRecord(indexContent) ||
      indexContent.active !== true
    ) {
      throw new StorageError("file not found");
    }
    const originalEvent = await this.getOriginalFileEventWithSignal(treeId, fileId, true, signal);
    if (originalEvent.isRedacted()) throw new StorageError("file not found");

    const metadataEventId = await this.sendEncryptedMetadataMessage(treeId, {
      msgtype: STORAGE_METADATA_MSGTYPE,
      body: name,
      file_event_id: fileId,
    }, signal);
    onMetadata?.(metadataEventId);
    let listingEventId: string | undefined;
    try {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      const listing = await this.client.sendStateEvent(
        treeId,
        UNSTABLE_MSC3089_BRANCH.name,
        { active: true, metadata_event_id: metadataEventId } as never,
        fileId,
        { abortSignal: signal },
      );
      listingEventId = listing.event_id;
      // Another device can delete the attachment after the preflight check.
      // Its redaction wins over this rename, including a late listing update.
      if ((await this.getOriginalFileEventWithSignal(treeId, fileId, true, signal)).isRedacted()) {
        await this.client.redactEvent(treeId, listing.event_id);
        await this.client.redactEvent(treeId, metadataEventId);
        this.fileNames.delete(this.fileNameKey(treeId, fileId));
        throw new StorageError("file was deleted while renaming; the rename was removed");
      }
      this.fileNames.set(this.fileNameKey(treeId, fileId), name);
    } catch (error) {
      if (error instanceof StorageError && error.message === "file was deleted while renaming; the rename was removed") throw error;
      throw new MutationPartialError("rename file", [metadataEventId, ...(listingEventId ? [listingEventId] : [])],
        "the encrypted name was accepted but the rename could not be completed or verified",
        { cause: error, treeId, backupTargets: [{ treeId, fileId, metadataEventId }] });
    }
  }

  /** Resolves an encrypted file name from the MSC3089 index pointer. */
  async getFileName(
    treeId: string,
    fileId: string,
    options?: MatrixRequestOptions & { refreshState?: boolean },
  ): Promise<string> {
    if (options?.signal?.aborted) throw new StorageError("operation cancelled");
    if (options?.refreshState !== false) await this.refreshRoomState(treeId, options);
    if ((await this.getOriginalFileEventStateWithSignal(treeId, fileId, matrixRequestSignal(options))).redacted) {
      throw new StorageError("file not found");
    }
    const tree = this.getTree(treeId);
    const branch = tree?.getFile(fileId);
    if (!branch || branch.isActive === false) throw new StorageError("file not found");
    const indexEvent = branch.indexEvent;
    const indexContent = indexEvent?.getContent();
    if (
      !indexEvent ||
      !indexEvent.getSender() ||
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
      event = await this.readEncryptedMetadataMessage(treeId, metadataEventId, false, matrixRequestSignal(options));
    } catch (error) {
      // File IDs remain listable on a fresh device while its room keys are
      // being restored. The caller can resolve the private name on retry.
      if (error instanceof UndecryptableFileError) return GENERIC_FILE_NAME;
      throw error;
    }
    if (event.getSender() !== indexEvent.getSender()) {
      throw new StorageError("encrypted file metadata author does not match its listing");
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
    if (!indexEvent) {
      throw new StorageError("encrypted file listing is unavailable");
    }
    if (
      !isRecord(content) ||
      typeof content.metadata_event_id !== "string"
    ) {
      return null;
    }
    return validateMatrixEventId(content.metadata_event_id, "file metadata event ID");
  }

  /** Fetches and validates a current encrypted rename event, allowing retries after redaction. */
  async getFileRenameMetadataEvent(
    treeId: string,
    fileId: string,
    metadataEventId: string,
  ): Promise<MatrixEvent> {
    const branch = this.getTree(treeId)?.getFile(fileId);
    const indexSender = branch?.indexEvent?.getSender();
    if (!indexSender) throw new StorageError("encrypted file listing is unavailable");
    const event = await this.readEncryptedMetadataMessage(treeId, metadataEventId, true);
    if (event.isRedacted()) return event;
    if (event.getSender() !== indexSender) {
      throw new StorageError("encrypted file metadata author does not match its listing");
    }
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
    return this.getOriginalFileEventWithSignal(treeId, fileId, allowRedacted);
  }

  private async getOriginalFileEventWithSignal(
    treeId: string,
    fileId: string,
    allowRedacted: boolean,
    signal?: AbortSignal,
  ): Promise<MatrixEvent> {
    const event = await this.readEncryptedMetadataMessage(treeId, fileId, allowRedacted, signal);
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

  /** Reads the server-authored file message envelope without requiring its Megolm key. */
  async getOriginalFileEventState(
    treeId: string,
    fileId: string,
  ): Promise<{ ownerUserId: string; redacted: boolean; canRedact: boolean }> {
    return this.getOriginalFileEventStateWithSignal(treeId, fileId);
  }

  private async getOriginalFileEventStateWithSignal(
    treeId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ ownerUserId: string; redacted: boolean; canRedact: boolean }> {
    const rawEvent = signal
      ? await requireMatrixHttpTransport(this.client).authedRequest<Awaited<ReturnType<MatrixClient["fetchRoomEvent"]>>>(
        Method.Get, `/rooms/${encodeURIComponent(treeId)}/event/${encodeURIComponent(fileId)}`,
        undefined, undefined, { prefix: ClientPrefix.V3, abortSignal: signal },
      )
      : await this.client.fetchRoomEvent(treeId, fileId);
    const event = this.client.getEventMapper()(rawEvent);
    const ownerUserId = event.getSender();
    if (
      event.getId() !== fileId ||
      event.getRoomId() !== treeId ||
      !ownerUserId ||
      event.getWireType() !== EventType.RoomMessageEncrypted
    ) {
      throw new StorageError("encrypted file message is invalid or unavailable");
    }
    const userId = this.client.getUserId();
    const room = this.client.getRoom(treeId);
    const canRedact = Boolean(
      userId && room?.currentState.maySendRedactionForEvent(event, userId),
    );
    return { ownerUserId, redacted: event.isRedacted(), canRedact };
  }

  private async createEncryptedFile(
    treeId: string,
    name: string,
    encryptedContents: ArrayBuffer | Uint8Array,
    info: Record<string, unknown>,
    additionalContent?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ event_id: string }> {
    validateFileName(name);
    // Refresh authoritative room state before publishing new encrypted
    // content; ordinary reads never rewrite room permissions.
    await this.refreshRoomState(treeId, { signal });
    if (signal?.aborted) throw new StorageError("operation cancelled");
    this.requireEncryptedStorageRoom(treeId);
    const bytes = encryptedContents instanceof Uint8Array
      ? encryptedContents
      : new Uint8Array(encryptedContents);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let mediaId: string | undefined;
    let fileId: string | undefined;
    try {
      const uploaded = await this.client.uploadContent(body, { includeFilename: false });
      if (typeof uploaded.content_uri !== "string" || uploaded.content_uri.length === 0) {
        throw new StorageError("encrypted media upload returned no content URI");
      }
      mediaId = uploaded.content_uri;
      if (signal?.aborted) throw new StorageError("operation cancelled");
      await this.refreshRoomState(treeId, { signal });
      if (signal?.aborted) throw new StorageError("operation cancelled");
      const fileContent: Record<string, unknown> = {
        ...additionalContent,
        msgtype: MsgType.File,
        body: name,
        url: mediaId,
        file: { ...info, url: mediaId },
        [UNSTABLE_MSC3089_LEAF.name]: {},
      };
      const sent = await this.client.sendMessage(treeId, fileContent as never);
      fileId = validateMatrixEventId(
        (sent as unknown as { event_id?: unknown } | undefined)?.event_id,
        "file upload response event ID",
      );
      if (signal?.aborted) throw new StorageError("operation cancelled");
      await this.client.sendStateEvent(
        treeId,
        UNSTABLE_MSC3089_BRANCH.name,
        { active: true, metadata_event_id: fileId } as never,
        fileId,
      );
      if (signal?.aborted) throw new StorageError("operation cancelled");
      this.fileNames.set(this.fileNameKey(treeId, fileId), name);
      return { event_id: fileId };
    } catch (error) {
      const rejected = error instanceof MatrixError &&
        error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408;
      if (!mediaId) {
        if (rejected) throw error;
        throw new MutationOutcomeUnknownError("file upload", { cause: error });
      }
      let cause = error;
      if (rejected) {
        try {
          await this.cleanupFileUpload(treeId, mediaId, fileId);
        } catch (cleanupError) {
          cause = new AggregateError([error, cleanupError], "file upload failed and cleanup is incomplete");
        }
        if (cause === error) {
          throw new StorageError("file upload was rejected; uploaded media and attachment were removed", { cause: error });
        }
      }
      throw new MutationPartialError(
        "file upload",
        fileId ? [mediaId, fileId] : [mediaId],
        `upload outcome needs reconciliation in ${treeId}; keep these media and attachment IDs and use cleanupFileUpload before uploading again`,
        {
          cause,
          treeId,
          backupTargets: fileId ? [{ treeId, fileId }] : [],
        },
      );
    }
  }

  /**
   * Discards a partial upload using its MutationPartialError.completedIds:
   * [mediaId, fileId?]. Explicit cleanup also covers an unacknowledged listing.
   * Keep the same IDs after failure and retry this operation, not the upload.
   */
  async cleanupFileUpload(
    treeId: string,
    mediaId: string,
    fileId?: string,
    options?: MatrixRequestOptions,
  ): Promise<void> {
    validateMatrixRoomId(treeId);
    if (!/^mxc:\/\/[^/]+\/[^/?#]+$/u.test(mediaId)) throw new StorageError("invalid media identifier");
    if (fileId !== undefined) validateMatrixEventId(fileId, "file upload event ID");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), matrixRequestTimeout(options) ?? MATRIX_HTTP_TIMEOUT_MS);
    const abort = (): void => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    try {
      await raceWithAbort((async () => {
        if (controller.signal.aborted) throw new StorageError("operation cancelled");
        let attachment: MatrixEvent | undefined;
        let listing: MatrixEvent | null = null;
        if (fileId) {
          const raw = await this.client.fetchRoomEvent(treeId, fileId);
          attachment = this.client.getEventMapper()(raw);
          await this.client.decryptEventIfNeeded(attachment);
          const content = attachment.getContent();
          if (attachment.getId() !== fileId || attachment.getRoomId() !== treeId ||
            attachment.getSender() !== this.client.getUserId() ||
            (!attachment.isRedacted() && (attachment.getWireType() !== EventType.RoomMessageEncrypted ||
              attachment.getType() !== EventType.RoomMessage || content.msgtype !== MsgType.File ||
              !isRecord(content.file) || content.file.url !== mediaId))) {
            throw new StorageError("partial upload attachment does not match the current user and media");
          }
          await this.refreshRoomState(treeId, { signal: controller.signal });
          listing = this.getStateEvent(treeId, UNSTABLE_MSC3089_BRANCH.name, fileId);
          if (listing && !listing.isRedacted() &&
            (listing.getSender() !== this.client.getUserId() || listing.getContent().metadata_event_id !== fileId)) {
            throw new StorageError("file changed after upload; use ordinary file deletion");
          }
        }
        if (controller.signal.aborted) throw new StorageError("operation cancelled");
        await deleteOwnedMedia(this.client, [mediaId], controller.signal);
        if (listing && !listing.isRedacted()) {
          await withMatrixMutationAbort(() => this.client.redactEvent(treeId, listing!.getId()!), controller.signal);
        }
        if (attachment && !attachment.isRedacted()) {
          await withMatrixMutationAbort(() => this.client.redactEvent(treeId, fileId!), controller.signal);
        }
        if (fileId) this.fileNames.delete(this.fileNameKey(treeId, fileId));
      })(), controller.signal, () => new MutationOutcomeUnknownError("file upload cleanup"));
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abort);
    }
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
   * store and the secret-storage callback wiring `keySafe` needs, starts the
   * client, waits for the first sync, and returns a ready TeleCryptIOStorage.
   *
   * The plain constructor remains available for advanced callers who need to
   * build/configure the MatrixClient themselves; in that case `keySafe` only
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
      cryptoCallbacks: cloneCryptoCallbacks(opts.cryptoCallbacks),
    });

    return TeleCryptIOStorage.bootstrap(client, opts);
  }

  /** Shared post-construction bootstrap for `create()`/`createFromOidc()`:
   * persistent crypto store, optional first sync, wrap in a `TeleCryptIOStorage`. */
  private static async bootstrap(
    client: MatrixClient,
    opts: Pick<
      CreateTeleCryptIOStorageOptions,
      | "userId"
      | "deviceId"
      | "persistentCryptoStore"
      | "cryptoDatabasePrefix"
      | "onKeySafeStateChanged"
      | "initialSyncLimit"
      | "startClient"
      | "syncTimeoutMs"
      | "initTimeoutMs"
      | "onProgress"
      | "signal"
    >,
  ): Promise<TeleCryptIOStorage> {
    const progress = opts.onProgress ?? (() => {});
    const persistent = opts.persistentCryptoStore ?? true;
    let storage: TeleCryptIOStorage | undefined;
    let syncOwnsCleanup = false;
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
      const crypto = client.getCrypto();
      if (!crypto) throw new StorageError("encryption is not initialized");
      crypto.setDeviceIsolationMode(new OnlySignedDevicesIsolationMode());
      progress("Encryption ready — opening secure store…");

      storage = new TeleCryptIOStorage(client, opts, opts);
      if (opts.startClient === false) {
        // Rust Crypto starts checking server-side backup state during init. A
        // short-lived caller (the CLI login transaction) may close this
        // client before that background check finishes, so drain it before
        // returning the sync-deferred client.
        const crypto = client.getCrypto();
        if (crypto) {
          await TeleCryptIOStorage.withTimeout(
            crypto.checkKeyBackupAndEnable(),
            opts.syncTimeoutMs ?? 15000,
            "crypto backup check",
            opts.signal,
          );
        }
      } else {
        syncOwnsCleanup = true;
        await storage.startSync(opts.signal);
      }
      return storage;
    } catch (error) {
      // stopClient is idempotent in matrix-js-sdk and is also required after
      // init/timeout failures: crypto startup can have installed listeners or
      // a sync task before the awaited operation rejects.
      if (!syncOwnsCleanup) {
        try {
          client.stopClient();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "storage bootstrap and client cleanup failed", {
            cause: error,
          });
        }
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

    const defaults = DEFAULT_TREE_POWER_LEVELS_TEMPLATE;
    return {
      name: GENERIC_TREE_NAME,
      preset: Preset.PrivateChat,
      power_level_content_override: {
        invite: defaults.invite,
        kick: defaults.kick,
        ban: defaults.ban,
        redact: defaults.redact,
        state_default: defaults.state_default,
        events_default: defaults.events_default,
        users_default: defaults.users_default,
        events: {
          ...defaults.events,
          [UNSTABLE_MSC3089_BRANCH.name]: 50,
          [STORAGE_METADATA_EVENT_TYPE]: 50,
        },
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
          content: { algorithm: STORAGE_ROOM_ENCRYPTION_ALGORITHM },
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
        if (tree && isStorageTreeRoom(this.client.getRoom(roomId))) {
          return this.decorateTreeSpace(tree);
        }
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
    const originalGetDirectory = typeof tree.getDirectory === "function"
      ? tree.getDirectory.bind(tree)
      : undefined;
    const originalListFiles = typeof tree.listFiles === "function"
      ? tree.listFiles.bind(tree)
      : () => [];
    const originalGetFile = typeof tree.getFile === "function"
      ? tree.getFile.bind(tree)
      : () => null;
    tree.getDirectories = () =>
      originalGetDirectories()
        .filter((child) =>
          !isTreeDeleted(this.client, child.id) &&
          isStorageTreeRoom(this.client.getRoom(child.id)),
        )
        .map((child) => this.decorateTreeSpace(child));
    if (originalGetDirectory) {
      tree.getDirectory = (roomId: string) => {
        const child = originalGetDirectory(roomId);
        return child &&
          !isTreeDeleted(this.client, child.id) &&
          isStorageTreeRoom(this.client.getRoom(child.id))
          ? this.decorateTreeSpace(child)
          : undefined;
      };
    }
    tree.createDirectory = (name: string) => this.createSubtree(tree, name);
    tree.setName = (name: string, signal?: AbortSignal, onMetadata?: (eventId: string) => void) => this.writeTreeName(tree.id, name, signal, onMetadata);
    tree.listFiles = () => originalListFiles().map((branch) => this.decorateFileBranch(tree.id, branch));
    tree.getFile = (fileId: string) => {
      const branch = originalGetFile(fileId);
      return branch ? this.decorateFileBranch(tree.id, branch) : null;
    };
    tree.createFile = (name, encryptedContents, info, additionalContent, signal) =>
      this.createEncryptedFile(tree.id, name, encryptedContents, info, additionalContent, signal);
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
        value: (name: string, signal?: AbortSignal, onMetadata?: (eventId: string) => void) => this.writeFileName(treeId, branch.id, name, signal, onMetadata),
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
    const http = requireMatrixHttpTransport(this.client);
    try {
      await http.authedRequest(
        Method.Post, `/rooms/${encodeURIComponent(roomId)}/leave`, undefined, {},
        { prefix: ClientPrefix.V3, abortSignal: cleanupSignal, localTimeoutMs: CLEANUP_TIMEOUT_MS },
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
        await http.authedRequest(
          Method.Post, `/rooms/${encodeURIComponent(roomId)}/forget`, undefined, undefined,
          { prefix: ClientPrefix.V3, abortSignal: cleanupSignal, localTimeoutMs: CLEANUP_TIMEOUT_MS },
        );
        this.client.store?.removeRoom(roomId);
        this.client.emit?.(ClientEvent.DeleteRoom, roomId);
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
    await this.redactRelationLink(roomId, eventId, signal);
    return true;
  }

  private async redactRelationLink(roomId: string, eventId: string, signal?: AbortSignal): Promise<void> {
    await requireMatrixHttpTransport(this.client).authedRequest(
      Method.Put, `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(this.client.makeTxnId())}`,
      undefined, {}, { prefix: ClientPrefix.V3, abortSignal: signal, localTimeoutMs: MATRIX_HTTP_TIMEOUT_MS },
    );
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
    const response = await requireMatrixHttpTransport(this.client).authedRequest<{ room_id: string }>(
      Method.Post, "/createRoom", undefined, this.treeRoomOptions(name),
      { prefix: ClientPrefix.V3, abortSignal: signal, localTimeoutMs: MATRIX_HTTP_TIMEOUT_MS },
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
        await this.writeTreeName(roomId, name, signal);
        if (signal?.aborted) throw new StorageError("operation cancelled");
      } catch (error) {
        try {
          await this.cleanupCreatedRoom(roomId);
        } catch (cleanupError) {
          if (error instanceof MutationPartialError) {
            throw new MutationPartialError(operation, [roomId, ...error.completedIds],
              "the encrypted name was accepted and room cleanup failed",
              { cause: new AggregateError([error, cleanupError], "creation and cleanup failed"),
                treeId: roomId, backupTargets: error.backupTargets });
          }
          throwWithCleanupDetail(error, roomId, cleanupError);
        }
        if (error instanceof MutationPartialError) {
          throw new MutationPartialError(operation, [roomId, ...error.completedIds],
            "the encrypted name was accepted and the created room was cleaned up",
            { cause: error, treeId: roomId });
        }
        throw new StorageError(`${operation}: encrypted name initialization failed`, { cause: error });
      }
      return tree;
    } catch (error) {
      if (error instanceof MutationPartialError) throw error;
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
      const tree = this.getTree(room.roomId);
      if (tree) trees.push(tree);
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
      let pendingLink: "parent" | "child" | undefined;
      try {
        const via = this.client.getDomain();
        if (!via) throw new Error("createSubtree: Matrix client has no server domain");

        parentLinkAttempted = true;
        pendingLink = "parent";
        const parentLink = await this.client.sendStateEvent(
          currentParent.id,
          EventType.SpaceChild,
          { via: [via] },
          tree.id,
          { abortSignal: effectiveSignal, localTimeoutMs: MATRIX_HTTP_TIMEOUT_MS },
        );
        pendingLink = undefined;
        if ((parentLink as { event_id?: unknown } | undefined)?.event_id !== undefined) {
          parentLinkEventId = validateMatrixEventId(
            (parentLink as { event_id?: unknown }).event_id,
            "parent link response event ID",
          );
        }
        childLinkAttempted = true;
        pendingLink = "child";
        const childLink = await this.client.sendStateEvent(
          tree.id,
          EventType.SpaceParent,
          { via: [via] },
          currentParent.id,
          { abortSignal: effectiveSignal, localTimeoutMs: MATRIX_HTTP_TIMEOUT_MS },
        );
        pendingLink = undefined;
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
      } catch (error) {
        // A Matrix authorization response is definitive: the currently
        // rejected state event was not committed. Keep rollback for links
        // that were already accepted, but don't classify an absent rejected
        // link as an ambiguous write that needs compensation.
        if (error instanceof MatrixError && error.errcode === "M_FORBIDDEN") {
          if (pendingLink === "parent") parentLinkAttempted = false;
          if (pendingLink === "child") childLinkAttempted = false;
        }
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
              await this.redactRelationLink(currentParent.id, parentLinkEventId, compensationSignal);
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
              await this.redactRelationLink(tree.id, childLinkEventId, compensationSignal);
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
      // Reconcile only after the child link is visible. A stale pre-creation
      // membership snapshot could re-invite someone removed while the room was
      // being created on another owner device.
      const reconcileInheritedAccess = async (): Promise<void> => {
        await this.refreshRoomState(currentParent.id, { signal: effectiveSignal });
        await this.refreshRoomState(tree.id, { signal: effectiveSignal });
        const parentMembers = await this.listMembers(currentParent, { signal: effectiveSignal });
        const childMembers = await this.listMembers(tree, { signal: effectiveSignal });
        const currentUser = this.client.getUserId();
        const desired = new Map(
          parentMembers
            .filter((member) => member.userId !== currentUser &&
              (member.membership === "join" || member.membership === "invite"))
            .map((member) => [member.userId, member]),
        );
        const childByUser = new Map(childMembers.map((member) => [member.userId, member]));
        for (const member of desired.values()) {
          if (effectiveSignal?.aborted) throw new StorageError("operation cancelled");
          if (await this.getRoomMembership(tree.id, member.userId, { signal: effectiveSignal }) === "ban") continue;
          const childMember = childByUser.get(member.userId);
          if (!childMember || (childMember.membership !== "join" && childMember.membership !== "invite")) {
            const verifyHistorySharing = await prepareReaderHistorySharing(this.client, member.userId);
            if (await this.getRoomMembership(tree.id, member.userId, { signal: effectiveSignal }) === "ban") continue;
            await withMatrixMutationAbort(() => tree.invite(member.userId, false), effectiveSignal);
            await verifyHistorySharing();
          }
          await this.refreshRoomState(tree.id, { signal: effectiveSignal });
          if (await this.getRoomMembership(tree.id, member.userId, { signal: effectiveSignal }) === "ban") continue;
          if (childMember?.role !== member.role) {
            await withMatrixMutationAbort(() => tree.setPermissions(member.userId, member.role), effectiveSignal);
            await this.refreshRoomState(tree.id, { signal: effectiveSignal });
          }
          const actual = await this.listMembers(tree, { signal: effectiveSignal });
          const granted = actual.find((candidate) => candidate.userId === member.userId);
          if (!granted || granted.role !== member.role ||
              (granted.membership !== "join" && granted.membership !== "invite")) {
            throw new Error("inherited folder access could not be verified");
          }
        }
        for (const member of childMembers) {
          if (member.userId === currentUser || desired.has(member.userId) ||
              (member.membership !== "join" && member.membership !== "invite" && member.membership !== "knock")) {
            continue;
          }
          try {
            await withMatrixMutationAbort(
              () => this.client.kick(tree.id, member.userId, "parent access was removed"),
              effectiveSignal,
            );
          } catch (error) {
            if (error instanceof MatrixError && error.errcode === "M_FORBIDDEN") {
              const after = await this.getRoomMembership(tree.id, member.userId, { signal: effectiveSignal });
              if (after === "leave" || after === "ban" || after === null) continue;
            }
            throw error;
          }
          const after = await this.getRoomMembership(tree.id, member.userId, { signal: effectiveSignal });
          if (after === "join" || after === "invite" || after === "knock") {
            throw new Error("removed parent access still has folder membership");
          }
        }
      };
      try {
        await reconcileInheritedAccess();
      } catch (error) {
        throw new MutationPartialError(
          "create folder",
          [tree.id],
          "the folder was created, but inherited access could not be verified",
          { cause: error, treeId: tree.id, backupTargets: [{ treeId: tree.id }] },
        );
      }
      return tree;
    }, signal);
  }

  getTree(roomId: string): TreeSpace | null {
    if (isTreeDeleted(this.client, roomId)) return null;
    if (!isStorageTreeRoom(this.client.getRoom(roomId))) return null;
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
    // Match matrix-js-sdk's MSC3089TreeSpace.getPermissions() default. An
    // explicit zero still means regular users lack the editor threshold.
    const editLevel = pls.events_default || 50;
    const adminLevel = pls.events?.["m.room.power_levels"] ?? 100;
    const room = this.client.getRoom(tree.id);
    const roleFor = (userId: string): string => {
      // RoomState applies Matrix's v12 creator power before the MSC3089
      // power-level event is converted into Storage's displayed roles.
      if (room?.currentState.getMember(userId)?.powerLevel === Number.POSITIVE_INFINITY) {
        return "owner";
      }
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
      // Let the in-flight request settle so the uploader can retain returned
      // media/event IDs on cancellation, then stop before the next write.
      response = await tree.createFile(
        name,
        new Uint8Array(encrypted.data),
        encrypted.info as unknown as Record<string, unknown>,
        { info: { mimetype, size: data.byteLength } },
        signal,
      );
    } catch (error) {
      // Preserve acknowledged upload stages after cancellation as well.
      if (error instanceof MutationOutcomeUnknownError || error instanceof MutationPartialError) throw error;
      if (error instanceof StorageError || error instanceof MatrixError) throw error;
      // An unclassified transport failure can still follow a committed event.
      throw new MutationOutcomeUnknownError("file upload", { cause: error });
    }
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
    let accessToken = clientAny.getAccessToken();
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
    let retriedAuthentication = false;
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
          let unknownToken = false;
          try {
            // Error responses are diagnostics, not product media. Consume the
            // complete body so no provider detail is discarded, then apply
            // the SDK's shared secret/control-character sanitizer before it
            // crosses the SDK boundary.
            const body = await readResponseBody(res, controller.signal);
            const responseText = new TextDecoder().decode(body.bytes);
            detail = sanitizeDiagnosticText(responseText);
            if (res.status === 401) {
              try {
                const errorBody: unknown = JSON.parse(responseText);
                unknownToken = isRecord(errorBody) && errorBody.errcode === "M_UNKNOWN_TOKEN";
              } catch { /* Non-Matrix errors retain the complete diagnostic below. */ }
            }
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
          if (unknownToken && !retriedAuthentication) {
            retriedAuthentication = true;
            // Matrix's authenticated transport owns token refresh, including
            // concurrent refreshes and persistence. Its media request path
            // buffers the whole body and follows redirects, so use a small
            // authenticated read to renew the session, then retry our bounded
            // streaming download once with the current token.
            await raceWithAbort(
              this.client.whoami(),
              controller.signal,
              () => signal?.aborted
                ? new StorageError("operation cancelled")
                : new Error("media download timed out"),
            );
            accessToken = clientAny.getAccessToken();
            validateMatrixToken(accessToken);
            continue;
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
