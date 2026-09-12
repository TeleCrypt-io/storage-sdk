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
  RoomCreateTypeField,
  RoomType,
  UNSTABLE_MSC3089_BRANCH,
  UNSTABLE_MSC3088_ENABLED,
  UNSTABLE_MSC3088_PURPOSE,
  UNSTABLE_MSC3089_TREE_SUBTYPE,
  type MatrixClient,
} from "matrix-js-sdk";
import { ClientPrefix } from "matrix-js-sdk/lib/http-api/prefix.js";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
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
import { validateName } from "./validation.js";
import {
  getDeletedTreeIds,
  isFileDeleted,
  isTreeDeleted,
  markFileDeleted,
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
  Member,
  RecoveryRestore,
  RecoverySetup,
  RenameResult,
  ShareResult,
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
// JavaScript timers cannot represent a longer delay reliably. The operation's
// own deadline remains the authority that stops retrying.
const MAX_TIMER_DELAY_MS = 2_147_483_647;
interface OperationDeadline {
  signal: AbortSignal;
  close: () => void;
}

type OperationKind = "read" | "mutation";

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

function isMarkedFileDeleted(
  storage: TeleCryptIOStorage,
  treeId: string,
  fileId: string,
): boolean {
  return isFileDeleted(storage.getClient(), treeId, fileId);
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
  if (isMarkedFileDeleted(storage, tree.id, fileId)) {
    throw new StorageError("file not found");
  }
  try {
    return await waitForCondition(
      () => (isMarkedFileDeleted(storage, tree.id, fileId) ? null : tree.getFile(fileId)),
      { timeoutMs: 15000, signal },
    );
  } catch (error) {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    if (error instanceof ConditionTimeoutError) throw new StorageError("file not found");
    throw new StorageError("file lookup failed", { cause: error });
  }
}

/**
 * Deleting a tree is deliberately a one-room operation. Callers must delete
 * files explicitly and observe each result before removing their containing
 * room. This also prevents a folder/vault delete from silently deleting a
 * nested shared tree.
 */
function assertTreeEmptyForDeletion(
  storage: TeleCryptIOStorage,
  tree: TreeSpace,
  spaces: readonly TreeSpace[],
): void {
  if (spaces.length !== 1) throw new NonEmptyTreeError(tree.id);
  let files: FileBranch[];
  try {
    files = tree.listFiles().filter((file) => !isMarkedFileDeleted(storage, tree.id, file.id));
  } catch (error) {
    throw new StorageError("could not enumerate storage files safely", { cause: error });
  }
  if (files.length > 0) throw new NonEmptyTreeError(tree.id);
}

async function refreshDeletionRooms(
  storage: TeleCryptIOStorage,
  rootId: string,
  signal?: AbortSignal,
): Promise<void> {
  const client = storage.getClient();
  const http = (client as unknown as { http?: { authedRequest?: unknown } }).http;
  // A real MatrixClient always exposes its authenticated HTTP transport. A
  // client without one cannot prove that its local relation graph is current.
  if (typeof http?.authedRequest !== "function") {
    throw new StorageError("delete graph refresh is unavailable");
  }
  await storage.refreshRoomState(rootId, { signal });
  if (signal?.aborted) throw new StorageError("operation cancelled");

  // The refreshed root owns its parent relation. Verify its one supported
  // external parent directly; unrelated local rooms are outside this deletion.
  const parentEvents = readRelationEvents(client, rootId, EventType.SpaceParent);
  if (parentEvents === null) throw new StorageError("delete graph is unsafe");
  const parentIds = new Set<string>();
  for (const event of parentEvents) {
    if (!isActiveRelationEvent(event)) continue;
    const parentId = relationStateKey(event);
    if (!parentId) throw new StorageError("delete graph is unsafe");
    if (parentId !== rootId) parentIds.add(parentId);
  }
  if (parentIds.size > 1) throw new StorageError("delete graph is unsafe");
  const parentId = parentIds.values().next().value;
  if (parentId) await storage.refreshRoomState(parentId, { signal });
  if (signal?.aborted) throw new StorageError("operation cancelled");
}

async function refreshTreeSpaces(
  storage: TeleCryptIOStorage,
  spaces: TreeSpace[],
  signal: AbortSignal,
): Promise<void> {
  for (const space of spaces) {
    ensureOperationActive(signal);
    await storage.refreshRoomState(space.id, { signal });
  }
}

type RelationEvent = {
  getStateKey?: () => string | undefined;
  getId?: () => string | undefined;
  getContent?: () => unknown;
};

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
  const room = client.getRoom?.(roomId) as { currentState?: RelationState } | null | undefined;
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

function activeTreeDirectories(client: MatrixClient, tree: TreeSpace): TreeSpace[] {
  const childEvents = readRelationEvents(client, tree.id, EventType.SpaceChild);
  if (childEvents === null) throw new StorageError("delete graph is unsafe");
  const activeChildIds = new Set<string>();
  for (const event of childEvents) {
    if (!isActiveRelationEvent(event)) continue;
    const childId = relationStateKey(event);
    if (!childId) throw new StorageError("delete graph is unsafe");
    activeChildIds.add(childId);
  }
  const knownChildren = new Map(
    tree.getDirectories().map((child) => [child.id, child]),
  );
  return [...activeChildIds].map((childId) => {
    const child = knownChildren.get(childId);
    if (!child) throw new StorageError("delete graph is unsafe");
    return child;
  });
}

function snapshotTreeSpaces(
  root: TreeSpace,
  activeRelationClient?: MatrixClient,
): TreeSpace[] {
  const spaces: TreeSpace[] = [];
  const seen = new Set<string>();
  const pending: TreeSpace[] = [root];
  while (pending.length > 0) {
    const tree = pending.pop();
    if (!tree) continue;
    if (seen.has(tree.id)) continue;
    seen.add(tree.id);
    spaces.push(tree);
    let children: TreeSpace[];
    try {
      children = activeRelationClient
        ? activeTreeDirectories(activeRelationClient, tree)
        : tree.getDirectories();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError("could not enumerate storage space descendants safely", { cause: error });
    }
    for (const child of children) pending.push(child);
  }
  return spaces;
}

interface ValidatedDeletionGraph {
  externalParents: string[];
}

/**
 * Deletion is intentionally narrower than MSC3089TreeSpace.delete(): a local
 * child graph is not proof that the rooms are exclusively owned by this tree.
 * Validate every observed edge in both directions and reject any parent or
 * child edge outside the exact deletion set before the first mutation.
 */
function validateDeletionGraph(
  client: MatrixClient,
  root: TreeSpace,
  ids: Set<string>,
  deletedRooms: ReadonlySet<string>,
): ValidatedDeletionGraph {
  const edges = new Set<string>();
  const externalParents: string[] = [];
  const addEdge = (parentId: string, childId: string): void => {
    if (deletedRooms.has(childId)) return;
    if (!ids.has(childId)) throw new StorageError("delete graph is unsafe");
    edges.add(`${parentId}\u0000${childId}`);
  };

  for (const id of ids) {
    const tree = client.unstableGetFileTreeSpace(id) as unknown as TreeSpace | null;
    if (!tree) throw new StorageError("delete graph is unsafe");
    const directories = activeTreeDirectories(client, tree);
    for (const child of directories) addEdge(id, child.id);

    const childEvents = readRelationEvents(client, id, EventType.SpaceChild);
    if (childEvents === null) throw new StorageError("delete graph is unsafe");
    for (const event of childEvents) {
      if (!isActiveRelationEvent(event)) continue;
      const childId = relationStateKey(event);
      if (!childId) throw new StorageError("delete graph is unsafe");
      addEdge(id, childId);
    }
  }

  for (const edge of edges) {
    const separator = edge.indexOf("\u0000");
    const parentId = edge.slice(0, separator);
    const childId = edge.slice(separator + 1);
    const childLink = readRelationEvents(client, parentId, EventType.SpaceChild, childId);
    const parentLink = readRelationEvents(client, childId, EventType.SpaceParent, parentId);
    if (
      !childLink?.some(
        (event) => isActiveRelationEvent(event) && relationStateKey(event, childId) === childId,
      ) ||
      !parentLink?.some(
        (event) => isActiveRelationEvent(event) && relationStateKey(event, parentId) === parentId,
      )
    ) {
      throw new StorageError("delete graph is unsafe");
    }
  }

  for (const id of ids) {
    const parentEvents = readRelationEvents(client, id, EventType.SpaceParent);
    if (parentEvents === null) throw new StorageError("delete graph is unsafe");
    for (const event of parentEvents) {
      if (!isActiveRelationEvent(event)) continue;
      const parentId = relationStateKey(event);
      if (!parentId) throw new StorageError("delete graph is unsafe");
      if (!ids.has(parentId)) {
        if (id !== root.id || externalParents.includes(parentId)) {
          throw new StorageError("delete graph is unsafe");
        }
        const childLink = readRelationEvents(client, parentId, EventType.SpaceChild, id);
        if (
          !childLink?.some(
            (candidate) => isActiveRelationEvent(candidate) && relationStateKey(candidate, id) === id,
          )
        ) {
          throw new StorageError("delete graph is unsafe");
        }
        externalParents.push(parentId);
      }
    }
  }

  if (!ids.has(root.id)) throw new StorageError("delete graph is unsafe");
  if (externalParents.length > 1) throw new StorageError("delete graph is unsafe");
  return { externalParents };
}

async function unlinkExternalParents(
  storage: TeleCryptIOStorage,
  rootId: string,
  externalParents: string[],
  signal?: AbortSignal,
): Promise<void> {
  const client = storage.getClient();
  let mutationAttempted = false;
  try {
    for (const parentId of externalParents) {
      if (signal?.aborted) throw new StorageError("operation cancelled");
      // Empty state-event content is the MSC3089-supported unlink form. Redaction
      // is not used here because it can be delayed or rejected independently of
      // the relation update.
      mutationAttempted = true;
      await withRateLimitRetry(
        () => withMatrixMutationAbort(() => client.sendStateEvent(parentId, EventType.SpaceChild, {}, rootId), signal),
        signal,
      );
      if (signal?.aborted) throw new StorageError("operation cancelled");
      await withRateLimitRetry(
        () => withMatrixMutationAbort(() => client.sendStateEvent(rootId, EventType.SpaceParent, {}, parentId), signal),
        signal,
      );
      await storage.refreshRoomState(parentId, { signal });
      await storage.refreshRoomState(rootId, { signal });
      const childLink = readRelationEvents(client, parentId, EventType.SpaceChild, rootId);
      const parentLink = readRelationEvents(client, rootId, EventType.SpaceParent, parentId);
      if (
        !childLink ||
        !parentLink ||
        childLink.some((event) => isActiveRelationEvent(event)) ||
        parentLink.some((event) => isActiveRelationEvent(event))
      ) {
        throw new StorageError("delete graph unlink could not be verified");
      }
    }
  } catch (error) {
    if (!mutationAttempted && error instanceof StorageError && error.message === "operation cancelled") {
      throw error;
    }
    // Unlinking is a two-room transaction. A failed second state update must
    // not leave a still-live vault detached from its external parent. Best
    // effort is insufficient here: surface a distinct failure if the repair
    // itself cannot be completed so callers never mistake a partial mutation
    // for a successful delete.
    try {
      await relinkExternalParents(storage, rootId, externalParents, new AbortController().signal);
    } catch (cleanupError) {
      throw new StorageError("delete graph unlink cleanup is incomplete", {
        cause: new AggregateError(
          [error, cleanupError],
          "delete graph unlink and relink both failed",
          { cause: error },
        ),
      });
    }
    throw error;
  }
}

async function relinkExternalParents(
  storage: TeleCryptIOStorage,
  rootId: string,
  externalParents: string[],
  signal?: AbortSignal,
): Promise<void> {
  const client = storage.getClient();
  const via = client.getDomain();
  if (!via) throw new StorageError("delete graph relink is unavailable");
  for (const parentId of externalParents) {
    if (signal?.aborted) throw new StorageError("operation cancelled");
    await withRateLimitRetry(
      () => withMatrixMutationAbort(() => client.sendStateEvent(parentId, EventType.SpaceChild, { via: [via] }, rootId), signal),
      signal,
    );
    await withRateLimitRetry(
      () => withMatrixMutationAbort(() => client.sendStateEvent(rootId, EventType.SpaceParent, { via: [via] }, parentId), signal),
      signal,
    );
    await storage.refreshRoomState(parentId, { signal });
    await storage.refreshRoomState(rootId, { signal });
    const childLink = readRelationEvents(client, parentId, EventType.SpaceChild, rootId);
    const parentLink = readRelationEvents(client, rootId, EventType.SpaceParent, parentId);
    if (
      !childLink?.some((event) => isActiveRelationEvent(event)) ||
      !parentLink?.some((event) => isActiveRelationEvent(event))
    ) {
      throw new StorageError("delete graph relink could not be verified");
    }
  }
}

function isGoneError(error: unknown): boolean {
  return (
    error instanceof MatrixError &&
    (error.errcode === "M_NOT_FOUND" || error.errcode === "M_UNKNOWN")
  );
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
    const tree = storage.getTree(roomId);
    if (!tree) throw new StorageError("delete graph is unsafe");
    const self = client.getUserId();
    if (!self) throw new StorageError("delete graph is unsafe");
    const members = await storage.listMembers(tree, { signal });
    if (members.some((member) => member.userId !== self && member.role === "owner" &&
        (member.membership === "join" || member.membership === "invite" || member.membership === "knock"))) {
      throw new StorageError("delete will not kick another room owner");
    }
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

    const ownMembership = await storage.getRoomMembership(roomId, undefined, { signal });
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

function isActiveMembership(membership: string): boolean {
  return membership === "join" || membership === "invite";
}

function isRevocableMembership(membership: string | null): boolean {
  return membership === "join" || membership === "invite" || membership === "knock";
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
    ensureOperationActive(signal);
    return { id: tree.id, name };
  }, "mutation");
}

/** Top-level vaults only — excludes subdirectories of an existing tree. */
export async function listVaults(
  storage: TeleCryptIOStorage,
  options?: OperationOptions,
): Promise<VaultInfo[]> {
  return withOperationDeadline(options, async (signal) => {
    const trees = await storage.listTrees(signal);
    return trees.filter((t) => t.isTopLevel).map((t) => ({ id: t.id, name: t.room.name }));
  });
}

/** Current account's effective role for a vault, or null while it is unavailable. */
export function getMyVaultRole(storage: TeleCryptIOStorage, vaultId: string): string | null {
  const userId = storage.getClient().getUserId();
  const tree = storage.getTree(vaultId);
  if (!userId || !tree) return null;
  return tree.getPermissions(userId);
}

export async function joinVault(
  storage: TeleCryptIOStorage,
  vaultId: string,
  options?: OperationOptions,
): Promise<JoinResult> {
  return withOperationDeadline(options, async (signal) => {
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
    if (membership === "join") return { vaultId, joined: true };
    try {
      await withRateLimitRetry(
        () => withMatrixMutationAbort(() => storage.getClient().joinRoom(vaultId), signal),
        signal,
      );
    } catch (err) {
      if (err instanceof MutationOutcomeUnknownError) throw err;
      if (err instanceof MatrixError && err.errcode === "M_FORBIDDEN") {
        const afterForbidden = await storage.getRoomMembership(vaultId, undefined, { signal });
        if (afterForbidden === "join") return { vaultId, joined: true };
      }
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("join failed", { cause: err });
    }
    ensureOperationActive(signal);
    return { vaultId, joined: true };
  }, "mutation");
}

function roomDisplayName(
  storage: TeleCryptIOStorage,
  roomId: string,
  fallbackName?: string,
): string {
  const client = storage.getClient();
  const room = client.getRoom(roomId);
  if (fallbackName?.trim()) return fallbackName.trim();
  if (room?.name) return room.name;
  const userId = client.getUserId();
  if (room && userId) return room.getDefaultRoomName(userId);
  return roomId;
}

function hasActiveSpaceParent(room: {
  currentState?: { getStateEvents?: (eventType: string, stateKey?: string) => unknown };
}): boolean {
  const result = room.currentState?.getStateEvents?.(EventType.SpaceParent);
  const events = result == null ? [] : Array.isArray(result) ? result : [result];
  return events.some((event) => isActiveRelationEvent(event as RelationEvent));
}

function isReviewedStorageTreeRoom(room: {
  currentState?: { getStateEvents?: (eventType: string, stateKey?: string) => unknown };
} | null | undefined): boolean {
  const createEvent = room?.currentState?.getStateEvents?.(EventType.RoomCreate, "") as
    | { getContent?: () => unknown }
    | null
    | undefined;
  const createContent = createEvent?.getContent?.() as Record<string, unknown> | undefined;
  const purposeEvent = room?.currentState?.getStateEvents?.(
    UNSTABLE_MSC3088_PURPOSE.name,
    UNSTABLE_MSC3089_TREE_SUBTYPE.name,
  ) as { getContent?: () => unknown } | null | undefined;
  const purposeContent = purposeEvent?.getContent?.() as Record<string, unknown> | undefined;
  return (
    createContent?.[RoomCreateTypeField] === RoomType.Space &&
    purposeContent?.[UNSTABLE_MSC3088_ENABLED.name] === true
  );
}

/** Rooms where this account is invited and the room looks like a file tree. */
export async function listPendingInvites(
  storage: TeleCryptIOStorage,
  options?: OperationOptions,
): Promise<VaultInfo[]> {
  return withOperationDeadline(options, async (signal) => {
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
      if (isReviewedStorageTreeRoom(room)) {
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
    const client = storage.getClient();
    try {
      const room = typeof client.getRoom === "function" ? client.getRoom(vaultId) : undefined;
      if (!room) throw new StorageError("decline failed");
      const localMembership =
        typeof (room as { getMyMembership?: unknown }).getMyMembership === "function"
          ? (room as { getMyMembership: () => string | null }).getMyMembership()
          : null;
      // Invites are destructive: refresh the exact room before validating its
      // space relation and local tree metadata. A stale sync snapshot could
      // otherwise make a now-nested or unrelated room look safe to forget.
      // Synapse deliberately rejects full-state reads for pre-join rooms, so
      // an invite/knock must use the reviewed stripped state delivered with
      // the invite; joined rooms still get the authoritative refresh.
      if (localMembership !== "invite" && localMembership !== "knock") {
        await storage.refreshRoomState(vaultId, { signal });
      }
      const currentRoom = typeof client.getRoom === "function" ? client.getRoom(vaultId) : undefined;
      // Matrix 42's unstableGetFileTreeSpace() intentionally returns null for
      // invited rooms: it only constructs a tree after local membership is
      // `join`. A pending invite is nevertheless a reviewed top-level tree
      // room, so validate the authoritative room state directly instead of
      // requiring a joined TreeSpace object.
      if (
        !currentRoom ||
        hasActiveSpaceParent(currentRoom) ||
        !isReviewedStorageTreeRoom(currentRoom)
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

/** Invites `userId` to the vault and applies the requested role. */
export async function shareVault(
  storage: TeleCryptIOStorage,
  vaultId: string,
  userId: string,
  role: string,
  options?: OperationOptions,
): Promise<ShareResult> {
  if (role !== "viewer" && role !== "editor") {
    throw new StorageError("invalid --role (must be viewer or editor)");
  }
  const operation = createOperationDeadline(options);
  const completedRoomIds = new Set<string>();
  try {
    ensureOperationActive(operation.signal);
    const tree = await resolveTree(storage, vaultId, operation.signal);
    const pending = withTreeMutation(storage.getClient(), async () => {
      try {
        ensureOperationActive(operation.signal);
        await storage.refreshRoomState(tree.id, { signal: operation.signal });
        const spaces = snapshotTreeSpaces(tree);
        await refreshTreeSpaces(storage, spaces, operation.signal);
        const currentUser = storage.getClient().getUserId();
        if (currentUser && userId === currentUser) {
          throw new StorageError("share target is the current user");
        }
        const currentMembers = await withRateLimitRetry(
          () => storage.listMembers(tree, { signal: operation.signal }),
          operation.signal,
        );
        if (currentMembers.some((member) => member.userId === userId && member.role === "owner")) {
          throw new StorageError("share will not demote an existing owner");
        }
        for (const [index, space] of spaces.entries()) {
          ensureOperationActive(operation.signal);
          const currentMembership =
            index === 0
              ? currentMembers.find((member) => member.userId === userId)?.membership
              : await storage.getRoomMembership(space.id, userId, {
                  signal: operation.signal,
                });
          if (isActiveMembership(currentMembership ?? "")) continue;
          try {
            await withRateLimitRetry(
              () => withMatrixMutationAbort(() => space.invite(userId), operation.signal),
              operation.signal,
            );
            completedRoomIds.add(space.id);
          } catch (error) {
            if (!(error instanceof MatrixError) || error.errcode !== "M_FORBIDDEN") throw error;

            // Synapse may race another invite/join and answer M_FORBIDDEN. Only
            // suppress that typed condition after re-reading authoritative
            // membership; never infer it from provider-controlled error text.
            const membership = await storage.getRoomMembership(space.id, userId, {
              signal: operation.signal,
            });
            if (!isActiveMembership(membership ?? "")) throw new StorageError("share failed");
          }
        }
        for (const space of spaces) {
          ensureOperationActive(operation.signal);
          const members =
            space.id === tree.id
              ? currentMembers
              : await withRateLimitRetry(
                  () => storage.listMembers(space, { signal: operation.signal }),
                  operation.signal,
                );
          if (members.some((member) => member.userId === userId && member.role === "owner")) {
            throw new StorageError("share will not demote an existing owner");
          }
          await withRateLimitRetry(
            () => withMatrixMutationAbort(() => space.setPermissions(userId, role), operation.signal),
            operation.signal,
          );
          completedRoomIds.add(space.id);
        }
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
            error.message === "operation cancelled")
        ) {
          throw error;
        }
        throw new StorageError("share failed", { cause: error });
      }
      return { vaultId, userId, role };
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
    ensureOperationActive(operation.signal);
    const tree = await resolveTree(storage, vaultId, operation.signal);
    const pending = withTreeMutation(storage.getClient(), async () => {
      try {
        const currentUser = storage.getClient().getUserId();
        if (currentUser && userId === currentUser) {
          throw new StorageError("unshare target is the current user");
        }
        await storage.refreshRoomState(tree.id, { signal: operation.signal });
        const spaces = snapshotTreeSpaces(tree);
        await refreshTreeSpaces(storage, spaces, operation.signal);
        for (const space of spaces) {
          ensureOperationActive(operation.signal);
          const members = await withRateLimitRetry(
            () => storage.listMembers(space, { signal: operation.signal }),
            operation.signal,
          );
          if (members.some((member) => member.userId === userId && member.role === "owner")) {
            throw new StorageError("unshare will not remove an existing owner");
          }
          let membership: string | null;
          try {
            membership = await storage.getRoomMembership(space.id, userId, {
              signal: operation.signal,
            });
          } catch (error) {
            if (isGoneError(error)) continue;
            throw error;
          }
          if (!isRevocableMembership(membership)) continue;
          try {
            await withRateLimitRetry(
              () =>
                withMatrixMutationAbort(
                  () => storage.getClient().kick(space.id, userId, "unshared"),
                  operation.signal,
                ),
              operation.signal,
            );
            completedRoomIds.add(space.id);
          } catch (error) {
            if (isGoneError(error)) continue;
            if (error instanceof MatrixError && error.errcode === "M_FORBIDDEN") {
              const afterForbidden = await storage.getRoomMembership(space.id, userId, {
                signal: operation.signal,
              });
              if (!isRevocableMembership(afterForbidden)) continue;
            }
            throw error;
          }
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
    return await raceOperationDeadline(operation, pending, "mutation");
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
): Promise<FileInfo[]> {
  return withOperationDeadline(options, async (signal) => {
    const tree = await resolveTree(storage, treeId, signal);
    try {
      await storage.refreshRoomState(treeId, { signal });
      ensureOperationActive(signal);
      const files = tree
        .listFiles()
        .filter((file) => !isMarkedFileDeleted(storage, tree.id, file.id));
      return files.map((f) => ({ id: f.id, name: f.getName() }));
    } catch (error) {
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("list files failed", { cause: error });
    }
  });
}

/** Lists the direct child folders of a vault or folder. */
export async function listSubfolders(
  storage: TeleCryptIOStorage,
  parentId: string,
  options?: OperationOptions,
): Promise<FolderInfo[]> {
  return withOperationDeadline(options, async (signal) => {
    const tree = await resolveTree(storage, parentId, signal);
    await storage.refreshRoomState(parentId, { signal });
    ensureOperationActive(signal);
    const directories = activeTreeDirectories(storage.getClient(), tree)
      .filter((directory) => !isMarkedTreeDeleted(storage, directory.id));
    return directories.map((d) => ({ id: d.id, name: d.room.name }));
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
    ensureOperationActive(signal);
    return { id: sub.id, name };
  }, "mutation");
}

async function renameTree(
  storage: TeleCryptIOStorage,
  treeId: string,
  name: string,
  options?: OperationOptions,
): Promise<RenameResult> {
  validateName(name, "name");
  return withOperationDeadline(options, async (signal) => {
    const tree = await resolveTree(storage, treeId, signal);
    try {
      await withRateLimitRetry(
        () => withMatrixMutationAbort(() => tree.setName(name), signal),
        signal,
      );
      await waitForCondition(
        async () => {
          ensureOperationActive(signal);
          const current = storage.getTree(treeId);
          if (current?.room.name === name) return current;
          await storage.refreshRoomState(treeId, { signal });
          const refreshed = storage.getTree(treeId);
          return refreshed?.room.name === name ? refreshed : null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) throw error;
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("rename failed", { cause: error });
    }
    return { id: treeId, name };
  }, "mutation");
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
    ensureOperationActive(operation.signal);
    const pending = withTreeMutation(client, async () => {
      if (isTreeDeleted(client, treeId)) return { id: treeId, deleted: true };

      const tree = await resolveTree(storage, treeId, operation.signal);
      // Read reconciliation state after this operation reaches the single
      // client queue; a preceding delete may have populated the set while we
      // were waiting for its turn.
      const removedRooms = getDeletedTreeIds(client);
      let graph: ValidatedDeletionGraph;
      try {
        // Re-read the candidate graph and any external parents it identifies
        // before taking the immutable graph snapshot. Unrelated rooms are not
        // part of this operation and must not block deletion merely because
        // their membership is not joined.
        await refreshDeletionRooms(storage, tree.id, operation.signal);
    const spaces = snapshotTreeSpaces(tree, client);
        const activeSpaces = spaces.filter(
          (space) => !removedRooms.has(space.id),
        );
        const ids = new Set(activeSpaces.map((space) => space.id));
        if (!ids.has(tree.id)) {
          if (removedRooms.has(tree.id)) {
            return { id: treeId, deleted: true };
          }
          throw new StorageError("delete graph is unsafe");
        }
        assertTreeEmptyForDeletion(storage, tree, activeSpaces);
        graph = validateDeletionGraph(client, tree, ids, removedRooms);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("delete failed", { cause: error });
      }

      // Keep external parent links intact until the room deletion succeeds.
      // Unlinking first would silently detach a live vault on failure.
      try {
        await unlinkExternalParents(storage, tree.id, graph.externalParents, operation.signal);
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError("delete failed", { cause: error });
      }
      try {
        await deleteRoomDeterministically(storage, tree.id, operation.signal);
      } catch (error) {
        // The root is still live when its relation is removed. If deletion then
        // fails, restore both sides before reporting failure; otherwise a live
        // vault would be silently detached from its external parent.
        try {
          await relinkExternalParents(storage, tree.id, graph.externalParents, new AbortController().signal);
        } catch (cleanupError) {
          throw new StorageError("delete cleanup is incomplete", {
            cause: new AggregateError(
              [error, cleanupError],
              "delete and external-parent relink both failed",
              { cause: error },
            ),
          });
        }
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
    const tree = await resolveTree(storage, treeId, signal);
    const branch = await resolveFile(storage, tree, fileId, signal);
    try {
      await withRateLimitRetry(
        () => withMatrixMutationAbort(() => branch.setName(name), signal),
        signal,
      );
      // `setName` resolves when the homeserver accepts the state event, but a
      // fresh CLI/UI process can still read the previous local room state for a
      // short time. Do not report success until this client has observed the new
      // name through its normal sync loop.
      await waitForCondition(
        () => {
          const current = tree.getFile(fileId);
          return current?.getName() === name ? current : null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) throw error;
      if (signal.aborted) throw new StorageError("operation cancelled");
      throw new StorageError("rename file failed", { cause: error });
    }
    return { id: fileId, name };
  }, "mutation");
}

interface FileDeletionHttpTransport {
  authedRequest: <T>(
    method: Method,
    path: string,
    query?: undefined,
    body?: unknown,
    options?: { prefix?: string; rawResponseBody?: boolean; abortSignal?: AbortSignal },
  ) => Promise<T>;
}

function requireFileDeletionTransport(client: MatrixClient): FileDeletionHttpTransport {
  const http = (client as unknown as { http?: FileDeletionHttpTransport }).http;
  if (!http || typeof http.authedRequest !== "function") {
    throw new StorageError("Matrix HTTP transport unavailable");
  }
  return http;
}

async function deleteFileMedia(
  storage: TeleCryptIOStorage,
  mediaIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const client = storage.getClient();
  const http = requireFileDeletionTransport(client);
  try {
    await withRateLimitRetry(
      () =>
        withMatrixMutationAbort(
          () =>
            http.authedRequest(
              Method.Post,
              "/io.telecrypt.storage/delete_media",
              undefined,
              { media_ids: [...mediaIds] },
              { prefix: ClientPrefix.Unstable, rawResponseBody: true, abortSignal: signal },
            ),
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
    const tree = await resolveTree(storage, treeId, signal);
    const branch = await resolveFile(storage, tree, fileId, signal);
    let fileInfo: Awaited<ReturnType<FileBranch["getFileInfo"]>>;
    try {
      fileInfo = await branch.getFileInfo();
    } catch (error) {
      throw new StorageError("could not resolve encrypted file safely", { cause: error });
    }
    const mediaId = fileInfo?.info?.url;
    if (typeof mediaId !== "string" || mediaId.length === 0) {
      throw new StorageError("encrypted file has no media identifier");
    }
    await deleteFileMedia(storage, [mediaId], signal);

    const completedIds: string[] = [];
    try {
      const client = storage.getClient();
      await withRateLimitRetry(
        () =>
          withMatrixMutationAbort(
            () => client.sendStateEvent(tree.id, UNSTABLE_MSC3089_BRANCH.name, {}, branch.id),
            signal,
            "delete file state",
          ),
        signal,
      );
      await withRateLimitRetry(
        () =>
          withMatrixMutationAbort(
            () => client.redactEvent(tree.id, branch.id),
            signal,
            "delete file event",
          ),
        signal,
      );
      completedIds.push(branch.id);
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) throw error;
      if (signal.aborted) {
        throw new MutationPartialError(
          "delete file",
          completedIds,
          "media was deleted but Matrix event cleanup was cancelled",
          { cause: error },
        );
      }
      throw new MutationPartialError(
        "delete file",
        completedIds,
        "media was deleted but Matrix event cleanup stopped",
        { cause: error },
      );
    }
    try {
      await waitForCondition(
        async () => {
          await storage.refreshRoomState(tree.id, { signal });
          ensureOperationActive(signal);
          const current = tree.getFile(fileId);
          // Matrix SDK keeps a redacted branch event in room state as an
          // inactive branch. Treat both an absent branch and that redacted
          // inactive branch as confirmed deletion.
          return !current || current.isActive === false ? true : null;
        },
        { timeoutMs: 15000, signal },
      );
    } catch (error) {
      if (error instanceof MutationOutcomeUnknownError) throw error;
      const detail = "Matrix deletion completed but the file state could not be verified";
      throw new MutationPartialError("delete file", completedIds, detail, { cause: error });
    }
    markFileDeleted(storage.getClient(), tree.id, branch.id);
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
  return withOperationDeadline(options, async (signal) => {
    const tree = await resolveTree(storage, treeId, signal);
    const fileId = await withRateLimitRetry(
      () => storage.uploadFile(tree, name, toArrayBuffer(bytes), mimetype, signal),
      signal,
    ).catch((error) => {
      if (error instanceof FileTooLargeError) throw error;
      if (error instanceof MutationOutcomeUnknownError) throw error;
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
        { cause: error },
      );
    }
    ensureOperationActive(signal);
    return { id: fileId, name, mimetype };
  }, "mutation");
}

export async function downloadFile(
  storage: TeleCryptIOStorage,
  treeId: string,
  fileId: string,
  options?: OperationOptions,
): Promise<DownloadedFile> {
  return withOperationDeadline(options, async (signal) => {
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
      name: branch.getName(),
    };
  });
}

export async function setupRecovery(
  storage: TeleCryptIOStorage,
  options?: OperationOptions,
): Promise<RecoverySetup> {
  return withOperationDeadline(options, (signal) => storage.keys.setupRecovery(signal), "mutation");
}

export async function restoreRecovery(
  storage: TeleCryptIOStorage,
  recoveryKey: string,
  options?: OperationOptions,
): Promise<RecoveryRestore> {
  return withOperationDeadline(options, (signal) =>
    storage.keys.restoreFromRecoveryKey(recoveryKey, signal),
    "mutation",
  );
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
    const tree = await resolveTree(storage, treeId, signal);
    const branch = await resolveFile(storage, tree, fileId, signal);
    const name = branch.getName();
    let mimetype: string | null = null;
    let size: number | null = null;
    let createdAt: string | null = null;
    let updatedAt: string | null = null;

    try {
      ensureOperationActive(signal);
      const event = await branch.getFileEvent();
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
    return { name, mimetype, size, createdAt, updatedAt };
  });
}

async function getTreeDetails(
  storage: TeleCryptIOStorage,
  treeId: string,
  signal?: AbortSignal,
): Promise<VaultDetails> {
  const tree = await resolveTree(storage, treeId, signal);
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
    name: tree.room.name || roomDisplayName(storage, treeId),
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
  return withOperationDeadline(options, (signal) => getTreeDetails(storage, vaultId, signal));
}

/** Returns details for a nested folder. */
export async function getFolderDetails(
  storage: TeleCryptIOStorage,
  folderId: string,
  options?: OperationOptions,
): Promise<FolderDetails> {
  return withOperationDeadline(options, (signal) => getTreeDetails(storage, folderId, signal));
}
