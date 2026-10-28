/**
 * Platform-agnostic operations: one function per user-facing action, each
 * taking an already-created `TeleCryptIOStorage` plus plain inputs and returning
 * one of the typed results in `./types.ts`. No I/O beyond the Matrix client
 * itself, no stdout, no `process`, no file paths — bytes in/out are always
 * `Uint8Array`. All callers run the same tested logic and share the same result
 * shapes.
 *
 * `core/` never creates the `TeleCryptIOStorage`/`MatrixClient` itself — store
 * config (persistent crypto store, session credentials, etc.) is
 * platform-specific and stays with the caller.
 */
import {
  FileBranch,
  readFileEventMetadata,
  TeleCryptIOStorage,
  TreeSpace,
  withMatrixMutationAbort,
  withTreeMutation,
} from "../TeleCryptIOStorage.js";
import {
  EventType,
  MatrixError,
  type MatrixClient,
  type MatrixEvent,
  UNSTABLE_MSC3089_BRANCH,
} from "matrix-js-sdk";
import { deleteOwnedMedia } from "../media.js";
import { validateMatrixEventId } from "./constants.js";
import {
  FileTooLargeError,
  MutationPartialError,
  MutationOutcomeUnknownError,
  NonEmptyTreeError,
  RoomCreationAmbiguousError,
  RoomCleanupIncompleteError,
  StorageError,
} from "./errors.js";
import { ConditionTimeoutError, waitForCondition } from "./poll.js";
import { hasStorageTreeMarkersRoom, isStorageTreeRoom, validateName } from "./validation.js";
import { prepareReaderHistorySharing } from "../sharing.js";
import {
  isTreeDeleted,
  markTreeDeleted,
} from "../deletion-markers.js";
import type {
  DownloadedFile,
  FolderDetails,
  FolderInfo,
  FileDetails,
  FileInfo,
  VaultDetails,
  VaultInfo,
  DeleteResult,
  JoinResult,
  ListedFileInfo,
  Member,
  MemberActionCapabilities,
  RenameResult,
  ShareResult,
  TreeActionCapabilities,
  TreeRole,
  UnshareResult,
} from "./types.js";

export interface OperationOptions {
  /** Cancels waits and rate-limit backoff before the next mutation. */
  signal?: AbortSignal;
  /** Optional wall-clock budget supplied by the caller. */
  timeoutMs?: number;
}

/**
 * Production Synapse enforces the built-in rc_messages budget (per-account
 * burst 10, refill 1/5s) on every room/state mutation the tree operations
 * issue. A delete/decline sequence (kick members + leave + forget) can
 * exceed the burst within seconds, so each operation retries on 429 with the
 * server-advised backoff. Mirrors the harness library suite's
 * `withRateLimitRetry`; must not mask non-rate-limit failures.
 */
const RATE_LIMIT_DEFAULT_DELAY_MS = 15_000;
const STORAGE_METADATA_EVENT_TYPE = "io.telecrypt.storage.metadata";
// JavaScript timers cannot represent a longer delay reliably. The operation's
// own deadline remains the authority that stops retrying.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
interface OperationDeadline {
  signal: AbortSignal;
  close: () => void;
}

type OperationKind = "read" | "mutation" | "settled-mutation";

function createOperationDeadline(options?: OperationOptions): OperationDeadline {
  const timeoutMs = options?.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new StorageError("invalid operation timeout");
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(options?.signal?.reason);
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  if (options?.signal?.aborted) onAbort();
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => controller.abort(new Error("operation timed out")), timeoutMs);
  return {
    signal: controller.signal,
    close: () => {
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener("abort", onAbort);
    },
  };
}

function ensureOperationActive(signal: AbortSignal): void {
  if (signal.aborted) throw new StorageError("operation cancelled");
}

async function raceOperationDeadline<T>(
  deadline: OperationDeadline,
  pending: Promise<T>,
  kind: OperationKind,
): Promise<T> {
  if (kind === "settled-mutation") return pending;
  let onAbort: (() => void) | undefined;
  try {
    const abort = new Promise<never>((_, reject) => {
      const abortHandler = (): void => {
        reject(
          kind === "mutation"
            ? new MutationOutcomeUnknownError("operation")
            : new StorageError("operation cancelled"),
        );
      };
      onAbort = abortHandler;
      deadline.signal.addEventListener("abort", abortHandler, { once: true });
      if (deadline.signal.aborted) abortHandler();
    });
    return await Promise.race([pending, abort]);
  } finally {
    if (onAbort) deadline.signal.removeEventListener("abort", onAbort);
  }
}

async function withOperationDeadline<T>(
  options: OperationOptions | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
  kind: OperationKind = "read",
): Promise<T> {
  const deadline = createOperationDeadline(options);
  try {
    ensureOperationActive(deadline.signal);
    const pending = Promise.resolve().then(() => operation(deadline.signal));
    return await raceOperationDeadline(deadline, pending, kind);
  } finally {
    deadline.close();
  }
}

function isRateLimited(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (!("isRateLimitError" in error)) return false;
  const isRateLimitError = (error as { isRateLimitError: unknown }).isRateLimitError;
  return typeof isRateLimitError === "function" && isRateLimitError.call(error) === true;
}

function requiresMutationReconciliation(error: unknown): boolean {
  return (
    error instanceof MutationOutcomeUnknownError ||
    error instanceof MutationPartialError ||
    error instanceof RoomCreationAmbiguousError ||
    error instanceof RoomCleanupIncompleteError
  );
}

async function withRateLimitRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    try {
      return await operation();
    } catch (error) {
      // A mutation that may have committed, or whose compensating cleanup is
      // incomplete, must be reconciled by its owner before any retry. A
      // server rate-limit response does not make repeating room creation safe.
      if (requiresMutationReconciliation(error)) {
        throw error;
      }
      if (!isRateLimited(error)) throw error;
      // The server's retry_after_ms only covers one token; tree operations
      // need several (kick + leave + forget). Wait at least 15s so the
      // burst refills.
      let retryAfter = RATE_LIMIT_DEFAULT_DELAY_MS;
      if (error instanceof Error && "getRetryAfterMs" in error) {
        const getRetryAfterMs = (error as { getRetryAfterMs: unknown }).getRetryAfterMs;
        if (typeof getRetryAfterMs === "function") {
          const advised = getRetryAfterMs.call(error);
          if (typeof advised === "number" && Number.isFinite(advised) && advised > 0) {
            retryAfter = Math.max(retryAfter, advised);
          }
        }
      }
      retryAfter = Math.min(retryAfter, MAX_TIMER_DELAY_MS);
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
        }, retryAfter);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
  }
}

/**
 * Resolves a vault or folder by ID, polling briefly: a room this same account just
 * created (or was just invited to, by another process/session) can be
 * momentarily absent from a from-scratch `/sync` before showing up moments
 * later — real async settling, not an instant "not found". Throws a clean
 * error if the storage tree still isn't visible once the poll times out.
 */
async function resolveTree(
  storage: TeleCryptIOStorage,
  treeId: string,
  signal?: AbortSignal,
): Promise<TreeSpace> {
  try {
    return await waitForCondition(() => storage.getTree(treeId), {
      timeoutMs: 15000,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    if (error instanceof ConditionTimeoutError) throw new StorageError("storage space not found");
    throw new StorageError("storage space lookup failed", { cause: error });
  }
}

function isMarkedTreeDeleted(storage: TeleCryptIOStorage, treeId: string): boolean {
  return isTreeDeleted(storage.getClient(), treeId);
}

/** As `resolveTree`, but for a specific file within an already-resolved
 * vault or folder — covers the same settling window for a file another
 * process/session just uploaded. */
async function resolveFile(
  storage: TeleCryptIOStorage,
  tree: TreeSpace,
  fileId: string,
  signal?: AbortSignal,
): Promise<FileBranch> {
  if (signal?.aborted) throw new StorageError("operation cancelled");
  try {
    return await waitForCondition(
      async () => {
        const branch = tree.getFile(fileId);
        if (!branch) return null;
        const state = await storage.getOriginalFileEventState(tree.id, fileId);
        if (state.redacted) throw new StorageError("file not found");
        return branch;
      },
      { timeoutMs: 15000, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    if (error instanceof ConditionTimeoutError) throw new StorageError("file not found");
    if (error instanceof StorageError && error.message === "file not found") throw error;
    throw new StorageError("file lookup failed", { cause: error });
  }
}

/**
 * Deleting a tree is deliberately a one-room operation. Callers must delete
 * files explicitly and observe each result before removing their containing
 * room. This also prevents a folder/vault delete from silently deleting a
 * nested shared tree.
 */
async function assertTreeEmptyForDeletion(
  storage: TeleCryptIOStorage,
  tree: TreeSpace,
): Promise<void> {
  let files: FileBranch[];
  try {
    files = tree.listFiles();
  } catch (error) {
    throw new StorageError("could not enumerate storage files safely", { cause: error });
  }
  try {
    for (const file of files) {
      const state = await storage.getOriginalFileEventState(tree.id, file.id);
      if (!state.redacted) throw new NonEmptyTreeError(tree.id);
    }
  } catch (error) {
    if (error instanceof NonEmptyTreeError) throw error;
    throw new StorageError("could not enumerate storage files safely", { cause: error });
  }

  const childEvents = readRelationEvents(storage.getClient(), tree.id, EventType.SpaceChild);
  if (childEvents === null) throw new StorageError("could not enumerate storage folders safely");
  for (const event of childEvents) {
    if (!isActiveRelationEvent(event)) continue;
    const childId = relationStateKey(event);
    if (!childId) throw new StorageError("could not enumerate storage folders safely");
    if (!isTreeDeleted(storage.getClient(), childId)) throw new NonEmptyTreeError(tree.id);
  }
}

async function refreshDeletionRooms(
  storage: TeleCryptIOStorage,
  rootId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const client = storage.getClient();
  await storage.refreshRoomState(rootId, { signal });
  if (signal?.aborted) throw new StorageError("operation cancelled");

  const parentEvents = readRelationEvents(client, rootId, EventType.SpaceParent);
  if (parentEvents === null) throw new StorageError("could not enumerate storage parent safely");
  const parentIds = new Set<string>();
  for (const event of parentEvents) {
    const parentId = relationStateKey(event);
    if (!parentId) throw new StorageError("could not enumerate storage parent safely");
    if (parentId !== rootId) parentIds.add(parentId);
  }
  if (parentIds.size > 1) throw new StorageError("storage room has multiple parents");
  const parents = [...parentIds];
  if (parents[0]) {
    await storage.refreshRoomState(parents[0], { signal });
  }
  if (signal?.aborted) throw new StorageError("operation cancelled");
  return parents;
}

async function refreshTreeSpaces(
  storage: TeleCryptIOStorage,
  root: TreeSpace,
  signal: AbortSignal,
): Promise<TreeSpace[]> {
  const spaces: TreeSpace[] = [];
  const seen = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    ensureOperationActive(signal);
    const space = pending.pop()!;
    if (seen.has(space.id)) continue;
    seen.add(space.id);
    await storage.refreshRoomState(space.id, { signal });
    const refreshedSpace = storage.getTree(space.id);
    if (!refreshedSpace || refreshedSpace.id !== space.id) {
      throw new StorageError("storage space lookup failed");
    }
    spaces.push(refreshedSpace);
    pending.push(...await activeTreeDirectories(storage, refreshedSpace, signal));
  }
  return spaces;
}

type RelationEvent = Pick<MatrixEvent, "getStateKey" | "getId" | "getSender" | "getContent" | "isRedacted">;

type RelationState = {
  getStateEvents?: (
    eventType: string,
    stateKey?: string,
  ) => RelationEvent | RelationEvent[] | null;
};

function readRelationEvents(
  client: MatrixClient,
  roomId: string,
  eventType: string,
  stateKey?: string,
): RelationEvent[] | null {
  const room = client.getRoom(roomId) as { currentState?: RelationState } | null;
  const currentState = room?.currentState;
  if (!currentState?.getStateEvents) return null;
  const result = currentState.getStateEvents(eventType, stateKey);
  if (result === null || result === undefined) return [];
  return Array.isArray(result) ? result : [result];
}

function relationStateKey(event: RelationEvent, fallback?: string): string | undefined {
  return event.getStateKey?.() ?? fallback;
}

function isActiveRelationEvent(event: RelationEvent): boolean {
  const content = event.getContent?.();
  return (
    typeof content === "object" &&
    content !== null &&
    !Array.isArray(content) &&
    Object.keys(content).length > 0
  );
}

async function activeTreeDirectories(
  storage: TeleCryptIOStorage,
  tree: TreeSpace,
  signal?: AbortSignal,
): Promise<TreeSpace[]> {
  const client = storage.getClient();
  const childEvents = readRelationEvents(client, tree.id, EventType.SpaceChild);
  if (childEvents === null) throw new StorageError("storage folder state is unavailable");
  const activeChildIds = new Set<string>();
  for (const event of childEvents) {
    if (!isActiveRelationEvent(event)) continue;
    const childId = relationStateKey(event);
    if (!childId) throw new StorageError("storage folder state is inconsistent");
    activeChildIds.add(childId);
  }
  const directories = await Promise.all([...activeChildIds].map(async (childId) => {
    if (isMarkedTreeDeleted(storage, childId)) return null;
    try {
      // The parent room's relationship state can arrive before Matrix SDK's
      // MSC3089 TreeSpace projection includes that child. Resolve the exact
      // room named by the active relation instead of treating that brief
      // projection lag as corrupt folder state.
      let joined = false;
      return await waitForCondition(
        async () => {
          const directory = storage.getTree(childId);
          if (directory?.id === childId) return directory;
          if (!joined && client.getRoom(childId)?.getMyMembership() === "invite") {
            await joinTreeRoom(storage, childId, signal ?? new AbortController().signal);
            joined = true;
          }
          return null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      if (error instanceof ConditionTimeoutError) {
        throw new StorageError("storage folder state is inconsistent");
      }
      throw new StorageError("storage folder state lookup failed", { cause: error });
    }
  }));
  return directories.filter((directory): directory is TreeSpace => directory !== null);
}

async function unlinkExternalParents(
  storage: TeleCryptIOStorage,
  rootId: string,
  externalParents: string[],
  signal?: AbortSignal,
): Promise<void> {
  const client = storage.getClient();
  const completedRelationEventIds: string[] = [];
  const redactRelation = async (
    roomId: string,
    eventType: string,
    stateKey: string,
  ): Promise<void> => {
    await storage.refreshRoomState(roomId, { signal });
    if (signal?.aborted) throw new StorageError("operation cancelled");
    const events = readRelationEvents(client, roomId, eventType, stateKey);
    if (events === null) throw new StorageError("storage folder state is unavailable");
    const event = events[0];
    if (!event || !isActiveRelationEvent(event)) return;
    const currentUserId = client.getUserId();
    const room = client.getRoom(roomId);
    if (
      !currentUserId ||
      !room?.currentState.maySendRedactionForEvent(event as MatrixEvent, currentUserId)
    ) {
      throw new StorageError("Matrix does not permit removing a storage folder link");
    }
    const eventId = validateMatrixEventId(event.getId(), "storage folder relation event ID");
    await withRateLimitRetry(
      () => withMatrixMutationAbort(() => client.redactEvent(roomId, eventId), signal),
      signal,
    );
    if (!completedRelationEventIds.includes(eventId)) completedRelationEventIds.push(eventId);
    await storage.refreshRoomState(roomId, { signal });
    const remaining = readRelationEvents(client, roomId, eventType, stateKey);
    if (remaining === null || remaining.some((candidate) => isActiveRelationEvent(candidate))) {
      throw new StorageError("delete graph unlink could not be verified");
    }
  };

  try {
    for (const parentId of externalParents) {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      // Redact owner-authored relations one room at a time. If the process stops
      // after the parent-side redaction, the redacted state key remains visible
      // and the next call continues with the child-side relation.
      await redactRelation(parentId, EventType.SpaceChild, rootId);
      await redactRelation(rootId, EventType.SpaceParent, parentId);
      await storage.refreshRoomState(parentId, { signal });
      await storage.refreshRoomState(rootId, { signal });
      const childLink = readRelationEvents(client, parentId, EventType.SpaceChild, rootId);
      const parentLink = readRelationEvents(client, rootId, EventType.SpaceParent, parentId);
      if (
        childLink === null ||
        parentLink === null ||
        childLink.some((event) => isActiveRelationEvent(event)) ||
        parentLink.some((event) => isActiveRelationEvent(event))
      ) {
        throw new StorageError("delete graph unlink could not be verified");
      }
    }
  } catch (error) {
    if (error instanceof MutationOutcomeUnknownError || error instanceof MutationPartialError) throw error;
    if (completedRelationEventIds.length > 0) {
      throw new MutationPartialError(
        "delete folder links",
        completedRelationEventIds,
        "some parent links were removed; retry deleting the same folder to finish unlinking",
        { cause: error },
      );
    }
    throw error;
  }
}

function isGoneError(error: unknown): boolean {
  return error instanceof MatrixError && error.httpStatus === 404 && error.errcode === "M_NOT_FOUND";
}

async function deleteRoomDeterministically(
  storage: TeleCryptIOStorage,
  roomId: string,
  signal?: AbortSignal,
): Promise<void> {
  const completedRoomIds: string[] = [];
  const markRoomMutationComplete = (): void => {
    if (!completedRoomIds.includes(roomId)) completedRoomIds.push(roomId);
  };
  try {
    const client = storage.getClient();
    const self = client.getUserId();
    if (!self) throw new StorageError("Matrix user identity is unavailable");
    const ownMembership = await storage.getRoomMembership(roomId, undefined, { signal });
    if (ownMembership === "leave" || ownMembership === "ban") {
      try {
        await withRateLimitRetry(() => withMatrixMutationAbort(() => client.forget(roomId), signal), signal);
      } catch (error) {
        if (!isGoneError(error)) throw error;
      }
      removeRoomFromLocalStore(client, roomId);
      markTreeDeleted(client, roomId);
      return;
    }
    const tree = storage.getTree(roomId);
    if (!tree) throw new StorageError("storage room is unavailable for deletion");
    const members = await storage.listMembers(tree, { signal });
    for (const member of members) {
      const membership = member.membership;
      if (
        member.userId === self ||
        (membership !== "join" && membership !== "invite" && membership !== "knock")
      ) {
        continue;
      }
      try {
        await withRateLimitRetry(
          () => withMatrixMutationAbort(() => client.kick(roomId, member.userId, "Room deleted"), signal),
          signal,
        );
        markRoomMutationComplete();
      } catch (error) {
        if (isGoneError(error)) continue;
        if (error instanceof MatrixError && error.errcode === "M_FORBIDDEN") {
          const currentMembership = await storage.getRoomMembership(roomId, member.userId, { signal });
          if (
            currentMembership === "leave" ||
            currentMembership === "ban" ||
            !currentMembership
          ) {
            continue;
          }
        }
        throw error;
      }
    }

    if (ownMembership === "join" || ownMembership === "invite" || ownMembership === "knock") {
      try {
        await withRateLimitRetry(() => withMatrixMutationAbort(() => client.leave(roomId), signal), signal);
        markRoomMutationComplete();
      } catch (error) {
        if (!isGoneError(error)) throw error;
      }
    }

    try {
      await withRateLimitRetry(() => withMatrixMutationAbort(() => client.forget(roomId), signal), signal);
      markRoomMutationComplete();
    } catch (error) {
      if (!isGoneError(error)) throw error;
    }
    removeRoomFromLocalStore(client, roomId);
    markTreeDeleted(client, roomId);
  } catch (error) {
    if (error instanceof MutationOutcomeUnknownError || error instanceof MutationPartialError) throw error;
    if (completedRoomIds.length > 0) {
      throw new MutationPartialError("delete", completedRoomIds, "room cleanup stopped", { cause: error });
    }
    throw error;
  }
}

/**
 * The SDK normally evicts a room as part of forget(). Keep the local-store
 * postcondition explicit because a custom store or a raced membership update
 * may otherwise leave a stale invite visible until the next sync.
 */
function removeRoomFromLocalStore(client: MatrixClient, roomId: string): void {
  client.store?.removeRoom(roomId);
}

function safePartialDetail(error: unknown): string | undefined {
  // Provider/Matrix errors can contain response bodies, URLs, or credentials.
  // StorageError messages are authored by this package; retain those local
  // policy details so callers still get useful owner/self-target diagnostics.
  if (!(error instanceof StorageError) || error instanceof MutationOutcomeUnknownError) return undefined;
  return error.message;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function createVault(
  storage: TeleCryptIOStorage,
  name: string,
  options?: OperationOptions,
): Promise<VaultInfo> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    let tree: TreeSpace;
    try {
      tree = await withRateLimitRetry(() => storage.createTree(name, signal), signal);
    } catch (error) {
      if (requiresMutationReconciliation(error)) {
        throw error;
      }
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("create vault failed", { cause: error });
    }
    if (signal.aborted) throw new MutationPartialError("create vault", [tree.id],
      "the vault was created before cancellation", { treeId: tree.id, backupTargets: [{ treeId: tree.id }] });
    return { id: tree.id, name };
  }, "settled-mutation");
}

/** Top-level vaults only — excludes subdirectories of an existing tree. */
export async function listVaults(
  storage: TeleCryptIOStorage,
  options?: OperationOptions,
): Promise<VaultInfo[]> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const trees = await storage.listTrees(signal);
    const topLevel = trees.filter((tree) => tree.isTopLevel);
    return Promise.all(
      topLevel.map(async (tree) => ({
        id: tree.id,
        name: await storage.getTreeName(tree.id, { signal }),
      })),
    );
  });
}

/** Current account's effective role for a vault, or null while it is unavailable. */
export function getMyVaultRole(storage: TeleCryptIOStorage, vaultId: string): string | null {
  const userId = storage.getClient().getUserId();
  const tree = storage.getTree(vaultId);
  if (!userId || !tree) return null;
  // RoomState computes v12 creators' effective power through the SDK's native
  // powerLevelForUserId path. MSC3089TreeSpace.getPermissions reads only the
  // power-level event, where an implicit creator has no explicit entry.
  if (storage.getClient().getRoom(vaultId)?.currentState.getMember(userId)?.powerLevel === Number.POSITIVE_INFINITY) {
    return "owner";
  }
  return tree.getPermissions(userId);
}

async function joinTreeRoom(
  storage: TeleCryptIOStorage,
  vaultId: string,
  signal: AbortSignal,
): Promise<void> {
  let membership: string | null;
  try {
    membership = await storage.getRoomMembership(vaultId, undefined, { signal });
  } catch (err) {
    if (signal.aborted) throw new StorageError("operation cancelled");
    // Synapse refuses GET /rooms/:room/members for an invited user with
    // M_FORBIDDEN. That response means the membership preflight cannot
    // inspect the room yet; it is not evidence that joining is forbidden.
    // Attempt the idempotent join and let its own response decide access.
    if (err instanceof MatrixError && err.errcode === "M_FORBIDDEN") {
      membership = null;
    } else {
      throw new StorageError("join failed", { cause: err });
    }
  }
  if (membership === "join") return;
  const client = storage.getClient();
  const userId = client.getUserId();
  if (userId && client.getRoom(vaultId)?.getMember(userId)?.membership !== "invite") {
    // MatrixClient.joinRoom reads the inviter from its local invite-room
    // state. A to-device history bundle can arrive first in the initial
    // sync, before that stripped invite state has reached the room store;
    // joining without it skips Matrix JS SDK's pending-bundle acceptance.
    try {
      await waitForCondition(
        () => client.getRoom(vaultId)?.getMember(userId)?.membership === "invite" ? true : null,
        { timeoutMs: 15000, signal },
      );
    } catch (err) {
      if (signal.aborted) throw new StorageError("operation cancelled");
      if (err instanceof ConditionTimeoutError) {
        throw new StorageError("the room invitation has not reached this login yet; retry joining", { cause: err });
      }
      throw err;
    }
  }
  try {
    await withRateLimitRetry(
      () => withMatrixMutationAbort(() => client.joinRoom(vaultId), signal),
      signal,
    );
  } catch (err) {
    if (err instanceof MutationOutcomeUnknownError) throw err;
    if (err instanceof MatrixError && err.errcode === "M_FORBIDDEN") {
      const afterForbidden = await storage.getRoomMembership(vaultId, undefined, { signal });
      if (afterForbidden === "join") return;
    }
    if (signal.aborted) throw new StorageError("operation cancelled");
    throw new StorageError("join failed", { cause: err });
  }
}

export async function joinVault(
  storage: TeleCryptIOStorage,
  vaultId: string,
  options?: OperationOptions,
): Promise<JoinResult> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const joined = new Set<string>();
    const pending = [vaultId];
    try {
      while (pending.length > 0) {
        ensureOperationActive(signal);
        const roomId = pending.shift()!;
        if (joined.has(roomId) || isMarkedTreeDeleted(storage, roomId)) continue;
        // Keep native joinRoom's inviter/history-bundle handling for every
        // child. Merely joining the root does not accept its child invites.
        await joinTreeRoom(storage, roomId, signal);
        joined.add(roomId);
        await resolveTree(storage, roomId, signal);
        await storage.refreshRoomState(roomId, { signal });
        const children = readRelationEvents(storage.getClient(), roomId, EventType.SpaceChild);
        if (children === null) throw new StorageError("storage folder state is unavailable");
        for (const child of children) {
          if (!isActiveRelationEvent(child)) continue;
          const childId = relationStateKey(child);
          if (!childId) throw new StorageError("storage folder state is inconsistent");
          pending.push(childId);
        }
      }
    } catch (error) {
      if (joined.size > 0) {
        throw new MutationPartialError("join", [...joined],
          "some folders were joined; retry accepting the same vault to finish", { cause: error });
      }
      throw error;
    }
    return { vaultId, joined: true };
  }, "mutation");
}

function roomDisplayName(
  _storage: TeleCryptIOStorage,
  _roomId: string,
  _fallbackName?: string,
): string {
  return "Encrypted storage";
}

function hasActiveSpaceParent(room: {
  currentState?: { getStateEvents?: (eventType: string, stateKey?: string) => unknown };
}): boolean {
  const result = room.currentState?.getStateEvents?.(EventType.SpaceParent);
  const events = result == null ? [] : Array.isArray(result) ? result : [result];
  return events.some((event) => isActiveRelationEvent(event as RelationEvent));
}

/** Rooms where this account is invited and the room looks like a file tree. */
export async function listPendingInvites(
  storage: TeleCryptIOStorage,
  options?: OperationOptions,
): Promise<VaultInfo[]> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const client = storage.getClient();
    const rooms = client.getRooms();
    const invites: VaultInfo[] = [];

    for (const room of rooms) {
      ensureOperationActive(signal);
      if (isMarkedTreeDeleted(storage, room.roomId)) continue;
      if (room.getMyMembership() !== "invite") continue;
      if (hasActiveSpaceParent(room)) continue;

      const tree = storage.getTree(room.roomId);
      if (tree) {
        if (tree.isTopLevel) {
          invites.push({
            id: tree.id,
            name: roomDisplayName(storage, room.roomId, tree.room.name),
          });
        }
        continue;
      }

      // Invite state may not have MSC3089 tree metadata yet — accept rooms whose
      // create event marks them as a file tree space.
      if (isStorageTreeRoom(room)) {
        invites.push({
          id: room.roomId,
          name: roomDisplayName(storage, room.roomId),
        });
      }
    }

    return invites;
  });
}

/** Decline a vault invite (same as leaving before join). */
export async function declineInvite(
  storage: TeleCryptIOStorage,
  vaultId: string,
  options?: OperationOptions,
): Promise<{ vaultId: string; declined: boolean }> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const client = storage.getClient();
    try {
      const room = client.getRoom(vaultId);
      if (!room) throw new StorageError("decline failed");
      const localMembership = room.getMyMembership();
      // Invites are destructive: refresh the exact room before validating its
      // space relation and local tree metadata. A stale sync snapshot could
      // otherwise make a now-nested or unrelated room look safe to forget.
      // Synapse deliberately rejects full-state reads for pre-join rooms, so
      // an invite/knock must use the reviewed stripped state delivered with
      // the invite; joined rooms still get the authoritative refresh.
      if (localMembership !== "invite" && localMembership !== "knock") {
        await storage.refreshRoomState(vaultId, { signal });
      }
      const currentRoom = client.getRoom(vaultId);
      // Matrix 42's unstableGetFileTreeSpace() intentionally returns null for
      // invited rooms: it only constructs a tree after local membership is
      // `join`. A pending invite is nevertheless a reviewed top-level tree
      // room, so validate the authoritative room state directly instead of
      // requiring a joined TreeSpace object.
      if (
        !currentRoom ||
        hasActiveSpaceParent(currentRoom) ||
        !hasStorageTreeMarkersRoom(currentRoom)
      ) {
        throw new StorageError("decline failed");
      }
      let membership: string | null;
      try {
        membership = await storage.getRoomMembership(vaultId, undefined, { signal });
      } catch (error) {
        // The membership endpoint is also forbidden for an invited user. The
        // local pre-join membership is the server-delivered invite state that
        // authorizes this narrowly scoped leave/forget operation.
        if (
          error instanceof MatrixError &&
          error.errcode === "M_FORBIDDEN" &&
          (localMembership === "invite" || localMembership === "knock")
        ) {
          membership = localMembership;
        } else {
          throw error;
        }
      }
      // Decline is intentionally narrower than delete/leave: it must never
      // remove an already-joined vault or forget an unrelated room ID.
      if (membership !== "invite" && membership !== "knock") {
        return { vaultId, declined: false };
      }
      try {
        await withRateLimitRetry(
          () => withMatrixMutationAbort(() => client.leave(vaultId), signal),
          signal,
        );
      } catch (error) {
        let suppress = isGoneError(error);
        if (!suppress && error instanceof MatrixError && error.errcode === "M_FORBIDDEN") {
          const after = await storage.getRoomMembership(vaultId, undefined, { signal });
          suppress = after !== "join" && after !== "invite" && after !== "knock";
        }
        if (!suppress) throw error;
      }
      try {
        await withRateLimitRetry(
          () => withMatrixMutationAbort(() => client.forget(vaultId), signal),
          signal,
        );
      } catch (error) {
        let suppress = isGoneError(error);
        if (!suppress && error instanceof MatrixError && error.errcode === "M_FORBIDDEN") {
          const after = await storage.getRoomMembership(vaultId, undefined, { signal });
          suppress = after !== "join" && after !== "invite" && after !== "knock";
        }
        if (!suppress) throw error;
      }
      removeRoomFromLocalStore(client, vaultId);
    } catch (error) {
      // A cancellation or transport failure after leave/forget may have
      // changed membership. Keep the outcome explicit instead of claiming a
      // clean decline.
      if (error instanceof MutationOutcomeUnknownError) throw error;
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("decline failed", { cause: error });
    }
    ensureOperationActive(signal);
    return { vaultId, declined: true };
  }, "mutation");
}

/** Shares the vault and its existing folders with `userId` at the selected role. */
export async function shareVault(
  storage: TeleCryptIOStorage,
  vaultId: string,
  userId: string,
  role: TreeRole,
  options?: OperationOptions,
): Promise<ShareResult> {
  if (role !== "viewer" && role !== "editor" && role !== "owner") {
    throw new StorageError("invalid storage role");
  }
  const operation = createOperationDeadline(options);
  const completedRoomIds = new Set<string>();
  try {
    await storage.keySafe.requireReady({ signal: operation.signal });
    ensureOperationActive(operation.signal);
    const tree = await resolveTree(storage, vaultId, operation.signal);
    const pending = withTreeMutation(storage.getClient(), async () => {
      try {
        ensureOperationActive(operation.signal);
        const spaces = await refreshTreeSpaces(storage, tree, operation.signal);
        const currentUser = storage.getClient().getUserId();
        if (currentUser && userId === currentUser) {
          throw new StorageError("share target is the current user");
        }
        const client = storage.getClient();
        for (const space of spaces) {
          ensureOperationActive(operation.signal);
          await storage.refreshRoomState(space.id, { signal: operation.signal });
          await storage.prepareTreePermissionsForAccessChange(space.id, { signal: operation.signal });
          const members = await withRateLimitRetry(
            () => storage.listMembers(space, { signal: operation.signal }),
            operation.signal,
          );
          let memberRole = members.find((candidate) => candidate.userId === userId)?.role;
          let membership = await storage.getRoomMembership(space.id, userId, {
            signal: operation.signal,
          });
          if (membership === "ban") {
            await withRateLimitRetry(
              () => withMatrixMutationAbort(() => client.unban(space.id, userId), operation.signal),
              operation.signal,
            );
            completedRoomIds.add(space.id);
            membership = await storage.getRoomMembership(space.id, userId, { signal: operation.signal });
          }
          if (membership !== "join") {
            // Only new or pending memberships run Matrix's native history-share
            // path. Updating a joined member's role does not reinvite them.
            const verifyHistorySharing = await prepareReaderHistorySharing(client, userId);
            await withRateLimitRetry(
              () => withMatrixMutationAbort(() => space.invite(userId, false), operation.signal),
              operation.signal,
            );
            completedRoomIds.add(space.id);
            await verifyHistorySharing();
            // The pre-invite snapshot has no role for a new member. Read the
            // server's current membership and power levels after the invite
            // so a default Viewer does not require a redundant power-level
            // write (which may be forbidden to an invite-only actor).
            memberRole = (await storage.listMembers(space, { signal: operation.signal }))
              .find((candidate) => candidate.userId === userId)?.role;
          }
          if (memberRole === undefined) {
            throw new StorageError("requested member role could not be read");
          }
          if (memberRole !== role) {
            await withRateLimitRetry(
              () => withMatrixMutationAbort(() => space.setPermissions(userId, role), operation.signal),
              operation.signal,
            );
            completedRoomIds.add(space.id);
            await storage.refreshRoomState(space.id, { signal: operation.signal });
          }
          const actual = await storage.listMembers(space, { signal: operation.signal });
          if (actual.find((candidate) => candidate.userId === userId)?.role !== role) {
            throw new StorageError("requested storage role could not be verified");
          }
        }
        const rootMembership = await storage.getRoomMembership(tree.id, userId, {
          signal: operation.signal,
        });
        if (rootMembership !== "join" && rootMembership !== "invite") {
          throw new StorageError("root membership could not be verified");
        }
        return { vaultId, userId, role, rootMembership };
      } catch (error) {
        if (error instanceof MutationOutcomeUnknownError) throw error;
        if (completedRoomIds.size > 0) {
          throw new MutationPartialError(
            "share",
            [...completedRoomIds],
            safePartialDetail(error),
            { cause: error },
          );
        }
        if (
          error instanceof StorageError &&
          (error.message === "share failed" ||
            error.message.includes("owner") ||
            error.message.includes("current user") ||
            error.message.includes("Decryption Key Safe") ||
            error.message === "operation cancelled")
        ) {
          throw error;
        }
        throw new StorageError("share failed", { cause: error });
      }
    }, operation.signal);
    return await raceOperationDeadline(operation, pending, "mutation");
  } finally {
    operation.close();
  }
}

export async function unshareVault(
  storage: TeleCryptIOStorage,
  vaultId: string,
  userId: string,
  options?: OperationOptions,
): Promise<UnshareResult> {
  const operation = createOperationDeadline(options);
  const completedRoomIds = new Set<string>();
  try {
    await storage.keySafe.requireReady({ signal: operation.signal });
    ensureOperationActive(operation.signal);
    const tree = await resolveTree(storage, vaultId, operation.signal);
    const pending = withTreeMutation(storage.getClient(), async () => {
      try {
        const currentUser = storage.getClient().getUserId();
        if (currentUser && userId === currentUser) {
          throw new StorageError("unshare target is the current user");
        }
        const revokeFromSpace = async (space: TreeSpace): Promise<void> => {
          ensureOperationActive(operation.signal);
          let membership: string | null;
          try {
            membership = await storage.getRoomMembership(space.id, userId, {
              signal: operation.signal,
            });
          } catch (error) {
            if (isGoneError(error)) return;
            throw error;
          }
          if (membership === "ban") return;
          try {
            await withRateLimitRetry(
              () =>
                storage.getClient().ban(space.id, userId, "unshared"),
              operation.signal,
            );
            completedRoomIds.add(space.id);
            const afterKick = await storage.getRoomMembership(space.id, userId, {
              signal: operation.signal,
            });
            if (afterKick !== "ban") {
              throw new StorageError("room membership removal could not be verified");
            }
          } catch (error) {
            if (isGoneError(error)) return;
            if (error instanceof MatrixError && error.errcode === "M_FORBIDDEN") {
              const afterForbidden = await storage.getRoomMembership(space.id, userId, {
                signal: operation.signal,
              });
              if (afterForbidden === "ban") return;
            }
            throw error;
          }
        };
        // Revoke the root first. A concurrently created child linked after
        // this point will observe the changed parent membership; children
        // already linked are collected only after the root revoke is visible.
        const pendingSpaces = [tree];
        const seen = new Set<string>();
        while (pendingSpaces.length) {
          const space = pendingSpaces.pop()!;
          if (seen.has(space.id)) continue;
          seen.add(space.id);
          await revokeFromSpace(space);
          await storage.refreshRoomState(space.id, { signal: operation.signal });
          const refreshed = storage.getTree(space.id);
          if (!refreshed) throw new StorageError("storage space lookup failed");
          pendingSpaces.push(...await activeTreeDirectories(storage, refreshed, operation.signal));
        }
      } catch (error) {
        if (error instanceof MutationOutcomeUnknownError) throw error;
        if (completedRoomIds.size > 0) {
          throw new MutationPartialError(
            "unshare",
            [...completedRoomIds],
            safePartialDetail(error),
            { cause: error },
          );
        }
        if (
          error instanceof StorageError &&
          (error.message.includes("owner") ||
            error.message.includes("current user") ||
            error.message === "operation cancelled")
        ) {
          throw error;
        }
        throw new StorageError("unshare failed", { cause: error });
      }
      return { vaultId, userId, removed: true };
    }, operation.signal);
    try {
      return await raceOperationDeadline(operation, pending, "mutation");
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError && completedRoomIds.size > 0) {
        throw new MutationPartialError("unshare", [...completedRoomIds],
          "cancellation interrupted the remaining room removals", { cause: error });
      }
      throw error;
    }
  } finally {
    operation.close();
  }
}

export async function listMembers(
  storage: TeleCryptIOStorage,
  vaultId: string,
  options?: OperationOptions,
): Promise<Member[]> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, vaultId, signal);
    try {
      return await withRateLimitRetry(() => storage.listMembers(tree, { signal }), signal);
    } catch (error) {
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("list members failed", { cause: error });
    }
  });
}

export async function listFiles(
  storage: TeleCryptIOStorage,
  treeId: string,
  options?: OperationOptions,
): Promise<ListedFileInfo[]> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, treeId, signal);
    try {
      await storage.refreshRoomState(treeId, { signal });
      ensureOperationActive(signal);
      const client = storage.getClient();
      const room = client.getRoom(tree.id);
      if (!room) throw new StorageError("storage room is unavailable");
      const userId = client.getUserId();
      const canRename = Boolean(
        userId &&
        room.currentState.maySendEvent(EventType.RoomMessageEncrypted, userId) &&
        room.currentState.mayClientSendStateEvent(UNSTABLE_MSC3089_BRANCH.name, client) &&
        room.currentState.mayClientSendStateEvent(STORAGE_METADATA_EVENT_TYPE, client)
      );
      const files = tree.listFiles();
      const result = await Promise.all(files.map(async (file) => {
        const state = await storage.getOriginalFileEventState(tree.id, file.id);
        if (state.redacted) return null;
        return {
          id: file.id,
          name: await storage.getFileName(tree.id, file.id, { signal, refreshState: false }),
          ownerUserId: state.ownerUserId,
          canRename,
          canDelete: state.ownerUserId === client.getUserId() && state.canRedact,
        };
      }));
      return result.filter((file): file is ListedFileInfo => file !== null);
    } catch (error) {
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("list files failed", { cause: error });
    }
  });
}

function powerLevelContent(room: NonNullable<ReturnType<MatrixClient["getRoom"]>>): Record<string, unknown> {
  const event = room.currentState.getStateEvents(EventType.RoomPowerLevels, "");
  const content = Array.isArray(event) ? undefined : event?.getContent();
  return typeof content === "object" && content !== null && !Array.isArray(content)
    ? content as Record<string, unknown>
    : {};
}

function numericPower(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function configuredUserPower(content: Record<string, unknown>, userId: string): number {
  const users = content.users;
  const usersMap = typeof users === "object" && users !== null && !Array.isArray(users)
    ? users as Record<string, unknown>
    : {};
  return numericPower(usersMap[userId], numericPower(content.users_default, 0));
}

function configuredRolePower(content: Record<string, unknown>, role: TreeRole): number {
  const events = content.events;
  const eventLevels = typeof events === "object" && events !== null && !Array.isArray(events)
    ? events as Record<string, unknown>
    : {};
  if (role === "viewer") return numericPower(content.users_default, 0);
  if (role === "editor") return numericPower(content.events_default, 50) || 50;
  return numericPower(eventLevels[EventType.RoomPowerLevels], 100) || 100;
}

function mayInviteMember(
  room: NonNullable<ReturnType<MatrixClient["getRoom"]>>,
  client: MatrixClient,
  actorPower: number,
): boolean {
  if (client.isGuest()) return false;
  const userId = client.getUserId();
  const member = userId ? room.currentState.getMember(userId) : null;
  if (member?.membership !== "join") return false;
  const content = powerLevelContent(room);
  // Matrix defaults invite to zero, while this SDK helper's generic default is
  // 50. Use its native threshold check when explicitly configured and apply
  // the Matrix protocol default when the event omits it.
  return typeof content.invite === "number"
    ? room.currentState.hasSufficientPowerLevelFor("invite", actorPower)
    : actorPower >= 0;
}

function mayAssignTreeRole(
  room: NonNullable<ReturnType<MatrixClient["getRoom"]>>,
  client: MatrixClient,
  targetUserId: string,
  role: TreeRole,
): boolean {
  const actorUserId = client.getUserId();
  if (!actorUserId || actorUserId === targetUserId) return false;
  const state = room.currentState;
  const actor = state.getMember(actorUserId);
  if (!actor || actor.membership !== "join") return false;
  if (
    !state.mayClientSendStateEvent(EventType.RoomPowerLevels, client)
  ) {
    return false;
  }
  const content = powerLevelContent(room);
  const targetPower = state.getMember(targetUserId)?.powerLevel ?? configuredUserPower(content, targetUserId);
  const desiredPower = configuredRolePower(content, role);
  return actor.powerLevel > targetPower && desiredPower <= actor.powerLevel;
}

function mayKickMember(
  room: NonNullable<ReturnType<MatrixClient["getRoom"]>>,
  client: MatrixClient,
  targetUserId: string,
): boolean {
  const actorUserId = client.getUserId();
  if (!actorUserId || actorUserId === targetUserId) return false;
  const state = room.currentState;
  const actor = state.getMember(actorUserId);
  const target = state.getMember(targetUserId);
  return Boolean(
    actor?.membership === "join" &&
    target &&
    (target.membership === "join" || target.membership === "invite" || target.membership === "knock") &&
    actor.powerLevel > target.powerLevel &&
    state.hasSufficientPowerLevelFor("kick", actor.powerLevel)
  );
}

function mayBanMember(
  room: NonNullable<ReturnType<MatrixClient["getRoom"]>>,
  client: MatrixClient,
  targetUserId: string,
): boolean {
  const actorId = client.getUserId();
  if (!actorId || actorId === targetUserId) return false;
  const state = room.currentState;
  const actor = state.getMember(actorId);
  const target = state.getMember(targetUserId);
  const targetPower = target?.powerLevel ?? configuredUserPower(powerLevelContent(room), targetUserId);
  return Boolean(actor?.membership === "join" && actor.powerLevel > targetPower &&
    state.hasSufficientPowerLevelFor("ban", actor.powerLevel));
}

function mayDeleteTreeRoom(
  client: MatrixClient,
  room: NonNullable<ReturnType<MatrixClient["getRoom"]>>,
): boolean {
  const userId = client.getUserId();
  if (!userId) return false;
  const ownMember = room.currentState.getMember(userId);
  if (!ownMember) return false;
  if (ownMember.membership === "leave" || ownMember.membership === "ban") return true;
  if (ownMember.membership !== "join") return false;
  for (const member of room.getMembers()) {
    if (
      member.userId !== userId &&
      (member.membership === "join" || member.membership === "invite" || member.membership === "knock") &&
      !mayKickMember(room, client, member.userId)
    ) {
      return false;
    }
  }
  const parents = readRelationEvents(client, room.roomId, EventType.SpaceParent);
  if (parents === null) return false;
  for (const parentEvent of parents) {
    if (!isActiveRelationEvent(parentEvent)) continue;
    const parentId = relationStateKey(parentEvent);
    if (!parentId || parentId === room.roomId) continue;
    const parentRoom = client.getRoom(parentId);
    if (!parentRoom) return false;
    const childEvents = readRelationEvents(client, parentId, EventType.SpaceChild, room.roomId);
    if (childEvents === null) return false;
    const activeChild = childEvents.find(isActiveRelationEvent);
    if (
      !room.currentState.maySendRedactionForEvent(parentEvent as MatrixEvent, userId) ||
      (activeChild && !parentRoom.currentState.maySendRedactionForEvent(activeChild as MatrixEvent, userId))
    ) {
      return false;
    }
  }
  return true;
}

/** Reads current native Matrix capabilities for the operations offered in a tree room. */
export async function getTreeActionCapabilities(
  storage: TeleCryptIOStorage,
  treeId: string,
  options?: OperationOptions,
): Promise<TreeActionCapabilities> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, treeId, signal);
    await storage.refreshRoomState(tree.id, { signal });
    const client = storage.getClient();
    const room = client.getRoom(tree.id);
    const userId = client.getUserId();
    const noActions: TreeActionCapabilities = {
      renameTree: false,
      uploadFile: false,
      renameFile: false,
      createSubfolder: false,
      deleteTree: false,
      inviteMembers: false,
    };
    if (!room || !userId) return noActions;
    const state = room.currentState;
    const actor = state.getMember(userId);
    const canWriteState = (eventType: string): boolean =>
      state.mayClientSendStateEvent(eventType, client);
    const canSendEncryptedMetadata = state.maySendEvent(EventType.RoomMessageEncrypted, userId) &&
      canWriteState(STORAGE_METADATA_EVENT_TYPE);
    return {
      renameTree: canSendEncryptedMetadata,
      uploadFile:
        state.maySendEvent(EventType.RoomMessageEncrypted, userId) &&
        canWriteState(UNSTABLE_MSC3089_BRANCH.name),
      renameFile:
        canSendEncryptedMetadata && canWriteState(UNSTABLE_MSC3089_BRANCH.name),
      createSubfolder: canWriteState(EventType.SpaceChild),
      deleteTree: mayDeleteTreeRoom(client, room),
      inviteMembers: Boolean(actor && mayInviteMember(room, client, actor.powerLevel)),
    };
  });
}

/** Reads native permissions for sharing, changing, or removing the supplied members. */
export async function getMemberActionCapabilities(
  storage: TeleCryptIOStorage,
  vaultId: string,
  targetUserIds: string[],
  options?: OperationOptions,
): Promise<Record<string, MemberActionCapabilities>> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, vaultId, signal);
    await storage.refreshRoomState(tree.id, { signal });
    const client = storage.getClient();
    const room = client.getRoom(tree.id);
    const userId = client.getUserId();
    const result: Record<string, MemberActionCapabilities> = {};
    const roles: TreeRole[] = ["viewer", "editor", "owner"];
    for (const targetUserId of targetUserIds) {
      const member = room?.currentState.getMember(targetUserId);
      const joined = member?.membership === "join";
      const canInvite = Boolean(room && userId && userId !== targetUserId && (
        joined || mayInviteMember(room, client, room.currentState.getMember(userId)?.powerLevel ?? -Infinity)
      ) && (member?.membership !== "ban" || mayBanMember(room, client, targetUserId)));
      const canChangeRole = Object.fromEntries(roles.map((role) => [
        role,
        Boolean(room && mayAssignTreeRole(room, client, targetUserId, role)),
      ])) as Record<TreeRole, boolean>;
      const targetMember = room?.currentState.getMember(targetUserId);
      const currentRole = targetMember?.powerLevel === Number.POSITIVE_INFINITY
        ? "owner"
        : tree.getPermissions(targetUserId);
      const roleForShare = Object.fromEntries(roles.map((role) => [
        role,
        canInvite && (currentRole === role || canChangeRole[role]),
      ])) as Record<TreeRole, boolean>;
      result[targetUserId] = {
        canShare: roleForShare,
        canChangeRole,
        canUnshare: Boolean(room && (member?.membership === "ban" || mayBanMember(room, client, targetUserId))),
      };
    }
    return result;
  });
}

/** Lists the direct child folders of a vault or folder. */
export async function listSubfolders(
  storage: TeleCryptIOStorage,
  parentId: string,
  options?: OperationOptions,
): Promise<FolderInfo[]> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, parentId, signal);
    await storage.refreshRoomState(parentId, { signal });
    ensureOperationActive(signal);
    const directories = (await activeTreeDirectories(storage, tree, signal))
      .filter((directory) => !isMarkedTreeDeleted(storage, directory.id));
    return Promise.all(
      directories.map(async (directory) => ({
        id: directory.id,
        name: await storage.getTreeName(directory.id, { signal }),
      })),
    );
  });
}

export async function createSubfolder(
  storage: TeleCryptIOStorage,
  parentId: string,
  name: string,
  options?: OperationOptions,
): Promise<FolderInfo> {
  validateName(name, "name");
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, parentId, signal);
    let sub: TreeSpace;
    try {
      sub = await withRateLimitRetry(() => storage.createSubtree(tree, name, signal), signal);
    } catch (error) {
      if (requiresMutationReconciliation(error)) {
        throw error;
      }
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("create folder failed", { cause: error });
    }
    if (signal.aborted) throw new MutationPartialError("create folder", [sub.id],
      "the folder was created before cancellation", { treeId: sub.id, backupTargets: [{ treeId: sub.id }] });
    return { id: sub.id, name };
  }, "settled-mutation");
}

async function renameTree(
  storage: TeleCryptIOStorage,
  treeId: string,
  name: string,
  options?: OperationOptions,
): Promise<RenameResult> {
  validateName(name, "name");
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, treeId, signal);
    let mutationAccepted = false;
    let metadataEventId: string | undefined;
    try {
      await withRateLimitRetry(
        () => (tree.setName as (value: string, signal?: AbortSignal, onMetadata?: (eventId: string) => void) => Promise<void>)(name, signal, (eventId) => { metadataEventId = eventId; }),
        signal,
      );
      mutationAccepted = true;
      await waitForCondition(
        async () => {
          ensureOperationActive(signal);
          const current = storage.getTree(treeId);
          if (!current) return null;
          return (await storage.getTreeName(treeId, { signal })) === name ? current : null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError || error instanceof MutationPartialError) throw error;
      if (mutationAccepted) {
        throw new MutationPartialError(
          "rename tree",
          [treeId],
          "the encrypted name write was accepted but could not be read back",
          { cause: error, treeId, backupTargets: [{ treeId, ...(metadataEventId ? { metadataEventId } : {}) }] },
        );
      }
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("rename failed", { cause: error });
    }
    return { id: treeId, name, ...(metadataEventId ? { backupTarget: { treeId, metadataEventId } } : {}) };
  }, "settled-mutation");
}

/** Renames a top-level Vault. */
export async function renameVault(
  storage: TeleCryptIOStorage,
  vaultId: string,
  name: string,
  options?: OperationOptions,
): Promise<RenameResult> {
  return renameTree(storage, vaultId, name, options);
}

/** Renames a nested folder. */
export async function renameFolder(
  storage: TeleCryptIOStorage,
  folderId: string,
  name: string,
  options?: OperationOptions,
): Promise<RenameResult> {
  return renameTree(storage, folderId, name, options);
}

async function deleteTree(
  storage: TeleCryptIOStorage,
  treeId: string,
  options?: OperationOptions,
): Promise<DeleteResult> {
  const operation = createOperationDeadline(options);
  const client = storage.getClient();
  try {
    await storage.keySafe.requireReady({ signal: operation.signal });
    ensureOperationActive(operation.signal);
    const pending = withTreeMutation(client, async () => {
      if (isTreeDeleted(client, treeId)) return { id: treeId, deleted: true };

      const ownMembership = await storage.getRoomMembership(treeId, undefined, {
        signal: operation.signal,
      });
      if (ownMembership === "leave" || ownMembership === "ban") {
        try {
          await deleteRoomDeterministically(storage, treeId, operation.signal);
        } catch (error) {
          if (error instanceof StorageError) throw error;
          throw new StorageError("delete cleanup failed", { cause: error });
        }
        return { id: treeId, deleted: true };
      }

      const tree = await resolveTree(storage, treeId, operation.signal);
      let externalParents: string[];
      try {
        // Deletion owns one room. Refresh its current state and its one
        // supported parent before checking files/folders or changing links.
        externalParents = await refreshDeletionRooms(storage, tree.id, operation.signal);
        await assertTreeEmptyForDeletion(storage, tree);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("delete failed", { cause: error });
      }

      try {
        await unlinkExternalParents(storage, tree.id, externalParents, operation.signal);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("delete failed", { cause: error });
      }
      try {
        await deleteRoomDeterministically(storage, tree.id, operation.signal);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("delete failed", { cause: error });
      }
      return { id: treeId, deleted: true };
    }, operation.signal);
    return await raceOperationDeadline(operation, pending, "mutation");
  } finally {
    operation.close();
  }
}

/** Deletes a top-level Vault. */
export async function deleteVault(
  storage: TeleCryptIOStorage,
  vaultId: string,
  options?: OperationOptions,
): Promise<DeleteResult> {
  return deleteTree(storage, vaultId, options);
}

/** Deletes a nested folder. */
export async function deleteFolder(
  storage: TeleCryptIOStorage,
  folderId: string,
  options?: OperationOptions,
): Promise<DeleteResult> {
  return deleteTree(storage, folderId, options);
}

export async function renameFile(
  storage: TeleCryptIOStorage,
  treeId: string,
  fileId: string,
  name: string,
  options?: OperationOptions,
): Promise<RenameResult> {
  validateName(name, "file name");
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, treeId, signal);
    const branch = await resolveFile(storage, tree, fileId, signal);
    let mutationAccepted = false;
    let metadataEventId: string | undefined;
    try {
      await withRateLimitRetry(
        () => (branch.setName as (value: string, signal?: AbortSignal, onMetadata?: (eventId: string) => void) => Promise<void>)(name, signal, (eventId) => { metadataEventId = eventId; }),
        signal,
      );
      mutationAccepted = true;
      // `setName` resolves when the homeserver accepts the state event, but a
      // fresh CLI/UI process can still read the previous local room state for a
      // short time. Do not report success until this client has observed the new
      // name through its normal sync loop.
      await waitForCondition(
        async () => {
          const current = tree.getFile(fileId);
          if (!current) return null;
          return (await storage.getFileName(treeId, fileId, { signal })) === name ? current : null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError || error instanceof MutationPartialError) throw error;
      if (mutationAccepted) {
        throw new MutationPartialError(
          "rename file",
          [fileId],
          "the encrypted name write was accepted but could not be read back",
          { cause: error, treeId, backupTargets: [{ treeId, fileId, ...(metadataEventId ? { metadataEventId } : {}) }] },
        );
      }
      if (error instanceof StorageError && error.message === "file was deleted while renaming; the rename was removed") throw error;
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("rename file failed", { cause: error });
    }
    return { id: fileId, name, ...(metadataEventId ? { backupTarget: { treeId, fileId, metadataEventId } } : {}) };
  }, "settled-mutation");
}

async function deleteFileMedia(
  storage: TeleCryptIOStorage,
  mediaIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const client = storage.getClient();
  try {
    await withRateLimitRetry(
      () =>
        withMatrixMutationAbort(
          () => deleteOwnedMedia(client, mediaIds, signal),
          signal,
          "delete file media",
        ),
      signal,
    );
  } catch (error) {
    if (error instanceof MutationOutcomeUnknownError) throw error;
    if (signal?.aborted) throw new StorageError("operation cancelled");
    throw new StorageError("delete file media failed", { cause: error });
  }
}

export async function deleteFile(
  storage: TeleCryptIOStorage,
  treeId: string,
  fileId: string,
  options?: OperationOptions,
): Promise<DeleteResult> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, treeId, signal);
    await storage.refreshRoomState(treeId, { signal });
    const state = await storage.getOriginalFileEventState(tree.id, fileId);
    if (state.redacted) return { id: fileId, deleted: true };
    if (state.ownerUserId !== storage.getClient().getUserId()) {
      throw new StorageError("only the file uploader may delete this file");
    }
    if (!state.canRedact) {
      throw new StorageError("Matrix does not permit redacting the original file message");
    }
    const originalEvent = await storage.getOriginalFileEvent(tree.id, fileId, true);
    if (originalEvent.isRedacted()) return { id: fileId, deleted: true };
    const originalContent = originalEvent.getContent();
    const fileDescriptor =
      typeof originalContent === "object" &&
      originalContent !== null &&
      !Array.isArray(originalContent) &&
      "file" in originalContent &&
      typeof originalContent.file === "object" &&
      originalContent.file !== null &&
      !Array.isArray(originalContent.file)
        ? originalContent.file as Record<string, unknown>
        : undefined;
    const mediaId = fileDescriptor?.url;
    if (typeof mediaId !== "string" || mediaId.length === 0) {
      throw new StorageError("encrypted file has no media identifier");
    }
    try {
      await deleteFileMedia(storage, [mediaId], signal);
    } catch (error) {
      if ((await storage.getOriginalFileEventState(tree.id, fileId)).redacted) {
        return { id: fileId, deleted: true };
      }
      throw error;
    }
    const completedIds = [mediaId];
    try {
      await withRateLimitRetry(
        () => withMatrixMutationAbort(
          () => storage.getClient().redactEvent(tree.id, fileId),
          signal,
          "delete original file message",
        ),
        signal,
      );
      completedIds.push(fileId);
    } catch (error) {
      let redacted = false;
      let readbackError: unknown;
      try {
        redacted = (await storage.getOriginalFileEventState(tree.id, fileId)).redacted;
      } catch (failure) {
        readbackError = failure;
      }
      if (redacted) {
        return { id: fileId, deleted: true };
      }
      const cause = readbackError === undefined
        ? error
        : new AggregateError([error, readbackError], "redaction failed and file state could not be verified");
      throw new MutationPartialError(
        "delete file",
        completedIds,
        "file media was deleted; retry with the original file ID to redact its message",
        { cause },
      );
    }
    try {
      await waitForCondition(
        async () => {
          await storage.refreshRoomState(tree.id, { signal });
          ensureOperationActive(signal);
          const current = await storage.getOriginalFileEventState(tree.id, fileId);
          return current.redacted ? true : null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) throw error;
      const detail = "Matrix deletion completed but the file state could not be verified";
      throw new MutationPartialError("delete file", completedIds, detail, { cause: error });
    }
    ensureOperationActive(signal);
    return { id: fileId, deleted: true };
  }, "mutation");
}

export async function uploadFile(
  storage: TeleCryptIOStorage,
  treeId: string,
  name: string,
  bytes: Uint8Array,
  mimetype: string,
  options?: OperationOptions,
): Promise<FileInfo> {
  const deadline = createOperationDeadline(options);
  try {
    const signal = deadline.signal;
    await storage.keySafe.requireReady({ signal });
    ensureOperationActive(signal);
    // Unlike a read, an upload must retain a receipt returned by an in-flight
    // mutation after cancellation. The uploader stops before another write
    // when this operation's signal aborts.
    const tree = await resolveTree(storage, treeId, signal);
    const fileId = await withRateLimitRetry(
      () => storage.uploadFile(tree, name, toArrayBuffer(bytes), mimetype, signal),
      signal,
    ).catch((error) => {
      if (error instanceof FileTooLargeError) throw error;
      if (error instanceof MutationOutcomeUnknownError || error instanceof MutationPartialError) throw error;
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("upload failed", { cause: error });
    });
    // The create-file request is acknowledged before the event necessarily
    // arrives in this client's sync timeline. A caller can otherwise report a
    // successful folder upload and immediately list a missing nested file.
    try {
      await waitForCondition(
        async () => {
          // Refresh the joined room's authoritative state before checking the
          // local tree. The sync loop carries timeline file events, while this
          // refresh closes the state lag for the room being uploaded into.
          await storage.refreshRoomState(tree.id, { signal });
          ensureOperationActive(signal);
          const file = tree.getFile(fileId);
          return file ?? null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) throw error;
      throw new MutationPartialError(
        "upload file",
        [fileId],
        "upload completed but the file could not be observed locally",
        { cause: error, treeId, backupTargets: [{ treeId, fileId }] },
      );
    }
    ensureOperationActive(signal);
    return { id: fileId, name, mimetype, ownerUserId: storage.getClient().getUserId()! };
  } finally {
    deadline.close();
  }
}

/** Discard the acknowledged stages of a failed upload using its retained IDs. */
export async function cleanupFileUpload(
  storage: TeleCryptIOStorage,
  treeId: string,
  mediaId: string,
  fileId?: string,
  options?: OperationOptions,
): Promise<void> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    await storage.cleanupFileUpload(treeId, mediaId, fileId, { signal });
  }, "mutation");
}

export async function downloadFile(
  storage: TeleCryptIOStorage,
  treeId: string,
  fileId: string,
  options?: OperationOptions,
): Promise<DownloadedFile> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, treeId, signal);
    const branch = await resolveFile(storage, tree, fileId, signal);
    let result;
    try {
      result = await storage.downloadFile(branch, signal);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("download failed", { cause: error });
    }
    ensureOperationActive(signal);
    return {
      bytes: new Uint8Array(result.data),
      mimetype: result.mimetype,
      name: await storage.getFileName(tree.id, fileId, { signal }),
    };
  });
}

function tsToIso(ts: number | undefined | null): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

export async function getFileDetails(
  storage: TeleCryptIOStorage,
  treeId: string,
  fileId: string,
  options?: OperationOptions,
): Promise<FileDetails> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    const tree = await resolveTree(storage, treeId, signal);
    await resolveFile(storage, tree, fileId, signal);
    const name = await storage.getFileName(tree.id, fileId, { signal });
    let mimetype: string | null = null;
    let size: number | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;

    try {
      ensureOperationActive(signal);
      const event = await storage.getOriginalFileEvent(tree.id, fileId);
      const metadata = readFileEventMetadata(event.getContent());
      mimetype = metadata.mimetype;
      size = metadata.size;
      createdAt = tsToIso(event.getTs());
      updatedAt = createdAt;
    } catch (error) {
      if (signal.aborted) throw new StorageError("operation cancelled");
      if (error instanceof StorageError) throw error;
      throw new StorageError("get file details failed", { cause: error });
    }

    ensureOperationActive(signal);
    const { ownerUserId } = await storage.getOriginalFileEventState(tree.id, fileId);
    return { ownerUserId, name, mimetype, size, createdAt, updatedAt };
  });
}

async function getTreeDetails(
  storage: TeleCryptIOStorage,
  treeId: string,
  signal?: AbortSignal,
): Promise<VaultDetails> {
  await resolveTree(storage, treeId, signal);
  if (signal?.aborted) throw new StorageError("operation cancelled");
  const client = storage.getClient();
  const room = client.getRoom(treeId);
  let createdAt: string | null = null;
  let memberCount: number | null = null;

  if (room) {
    const createEvent = room.currentState?.getStateEvents("m.room.create", "");
    createdAt = tsToIso(createEvent?.getTs());
    try {
      memberCount = room.getJoinedMemberCount();
    } catch (error) {
      throw new StorageError("member count lookup failed", { cause: error });
    }
  }

  return {
    name: await storage.getTreeName(treeId, { signal }),
    id: treeId,
    createdAt,
    memberCount,
  };
}

/** Returns details for a top-level Vault. */
export async function getVaultDetails(
  storage: TeleCryptIOStorage,
  vaultId: string,
  options?: OperationOptions,
): Promise<VaultDetails> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    return getTreeDetails(storage, vaultId, signal);
  });
}

/** Returns details for a nested folder. */
export async function getFolderDetails(
  storage: TeleCryptIOStorage,
  folderId: string,
  options?: OperationOptions,
): Promise<FolderDetails> {
  return withOperationDeadline(options, async (signal) => {
    await storage.keySafe.requireReady({ signal });
    return getTreeDetails(storage, folderId, signal);
  });
}
