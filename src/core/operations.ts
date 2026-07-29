/**
 * Platform-agnostic operations: one function per user-facing action, each
 * taking an already-created `TeleCryptIOStorage` plus plain inputs and returning
 * one of the typed results in `./types.ts`. No I/O beyond the Matrix client
 * itself, no stdout, no `process`, no file paths — bytes in/out are always
 * `Uint8Array`. This is what the CLI's command actions call today and what
 * a future React UI calls directly, so both run the exact same tested logic
 * and share the exact same result shapes.
 *
 * `core/` never creates the `TeleCryptIOStorage`/`MatrixClient` itself — store
 * config (persistent crypto store, session credentials, etc.) is
 * platform-specific and stays with the caller (see `src/cli/storage.ts`).
 */
import { FileBranch, TeleCryptIOStorage, TreeSpace } from "../TeleCryptIOStorage.js";
import { CliError } from "./errors.js";
import { waitForCondition } from "./poll.js";
import type {
  DownloadedFile,
  FileDetails,
  FileInfo,
  FolderDetails,
  FolderInfo,
  DeleteResult,
  JoinResult,
  Member,
  RecoveryRestore,
  RecoverySetup,
  RenameResult,
  ShareResult,
  UnshareResult,
} from "./types.js";

/**
 * Resolves a folder by ID, polling briefly: a room this same account just
 * created (or was just invited to, by another process/session) can be
 * momentarily absent from a from-scratch `/sync` before showing up moments
 * later — real async settling, not an instant "not found". Throws a clean
 * error if the folder still isn't visible once the poll times out.
 */
async function resolveTree(storage: TeleCryptIOStorage, folderId: string): Promise<TreeSpace> {
  try {
    return await waitForCondition(() => storage.getTree(folderId), {
      timeoutMs: 15000,
    });
  } catch {
    throw new CliError(`folder not found: ${folderId}`);
  }
}

/** As `resolveTree`, but for a specific file within an already-resolved
 * folder — covers the same settling window for a file another
 * process/session just uploaded. */
async function resolveFile(tree: TreeSpace, fileId: string): Promise<FileBranch> {
  try {
    return await waitForCondition(() => tree.getFile(fileId), { timeoutMs: 15000 });
  } catch {
    throw new CliError(`file not found: ${fileId}`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function createFolder(storage: TeleCryptIOStorage, name: string): Promise<FolderInfo> {
  const tree = await storage.createTree(name);
  return { id: tree.id, name };
}

/** Top-level folders only — excludes subdirectories of an existing tree. */
export async function listFolders(storage: TeleCryptIOStorage): Promise<FolderInfo[]> {
  const trees = await storage.listTrees();
  return trees.filter((t) => t.isTopLevel).map((t) => ({ id: t.id, name: t.room.name }));
}

/** Current account's effective role for a folder, or null while it is unavailable. */
export function getMyFolderRole(storage: TeleCryptIOStorage, folderId: string): string | null {
  const userId = storage.getClient().getUserId();
  const tree = storage.getTree(folderId);
  if (!userId || !tree) return null;
  return tree.getPermissions(userId);
}

export async function joinFolder(storage: TeleCryptIOStorage, folderId: string): Promise<JoinResult> {
  try {
    await storage.getClient().joinRoom(folderId);
  } catch (err) {
    throw new CliError(`join failed: ${(err as Error).message}`);
  }
  return { folderId, joined: true };
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

/** Rooms where this account is invited and the room looks like a file tree. */
export async function listPendingInvites(storage: TeleCryptIOStorage): Promise<FolderInfo[]> {
  const client = storage.getClient();
  const invites: FolderInfo[] = [];

  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== "invite") continue;

    const tree = storage.getTree(room.roomId);
    if (tree) {
      invites.push({
        id: tree.id,
        name: roomDisplayName(storage, room.roomId, tree.room.name),
      });
      continue;
    }

    // Invite state may not have MSC3089 tree metadata yet — accept rooms whose
    // create event marks them as a file tree space.
    const createEvent = room.currentState?.getStateEvents("m.room.create", "");
    const createContent = createEvent?.getContent() as Record<string, unknown> | undefined;
    const roomType = createContent?.["type"];
    if (roomType === "org.matrix.msc3088.file" || roomType === "m.space") {
      invites.push({
        id: room.roomId,
        name: roomDisplayName(storage, room.roomId),
      });
    }
  }

  return invites;
}

/** Decline a folder invite (same as leaving before join). */
export async function declineInvite(
  storage: TeleCryptIOStorage,
  folderId: string,
): Promise<{ folderId: string; declined: boolean }> {
  try {
    await storage.getClient().leave(folderId);
  } catch (err) {
    throw new CliError(`decline failed: ${(err as Error).message}`);
  }
  return { folderId, declined: true };
}

/**
 * Invites `userId` to the folder at `role` and applies the role's
 * permissions. Doubles as "change an existing participant's role" (call
 * again with a different role): inviting someone who's already a member is
 * a 403 from the server, not a real failure — that specific error is
 * swallowed and the role change still applies. Any other invite failure
 * (e.g. unknown user) propagates.
 */
export async function shareFolder(
  storage: TeleCryptIOStorage,
  folderId: string,
  userId: string,
  role: string,
): Promise<ShareResult> {
  if (role !== "viewer" && role !== "editor") {
    throw new CliError(`invalid --role "${role}" (must be viewer or editor)`);
  }
  const tree = await resolveTree(storage, folderId);
  try {
    await tree.invite(userId);
  } catch (err) {
    if (!/already in the room/i.test((err as Error).message)) {
      throw err;
    }
  }
  await tree.setPermissions(userId, role);
  return { folderId, userId, role };
}

export async function unshareFolder(
  storage: TeleCryptIOStorage,
  folderId: string,
  userId: string,
): Promise<UnshareResult> {
  await resolveTree(storage, folderId);
  try {
    await storage.getClient().kick(folderId, userId, "unshared");
  } catch (err) {
    throw new CliError(`unshare failed: ${(err as Error).message}`);
  }
  return { folderId, userId, removed: true };
}

export async function listMembers(storage: TeleCryptIOStorage, folderId: string): Promise<Member[]> {
  const tree = await resolveTree(storage, folderId);
  return storage.listMembers(tree);
}

export async function listFiles(storage: TeleCryptIOStorage, folderId: string): Promise<FileInfo[]> {
  const tree = await resolveTree(storage, folderId);
  return tree.listFiles().map((f) => ({ id: f.id, name: f.getName() }));
}

export async function listSubfolders(
  storage: TeleCryptIOStorage,
  folderId: string,
): Promise<FolderInfo[]> {
  const tree = await resolveTree(storage, folderId);
  return tree.getDirectories().map((d) => ({ id: d.id, name: d.room.name }));
}

export async function createSubfolder(
  storage: TeleCryptIOStorage,
  folderId: string,
  name: string,
): Promise<FolderInfo> {
  const tree = await resolveTree(storage, folderId);
  const sub = await tree.createDirectory(name);
  return { id: sub.id, name };
}

export async function renameFolder(
  storage: TeleCryptIOStorage,
  folderId: string,
  name: string,
): Promise<RenameResult> {
  const tree = await resolveTree(storage, folderId);
  await tree.setName(name);
  return { id: folderId, name };
}

export async function deleteFolder(
  storage: TeleCryptIOStorage,
  folderId: string,
): Promise<DeleteResult> {
  const tree = await resolveTree(storage, folderId);
  await tree.delete();
  return { id: folderId, deleted: true };
}

export async function renameFile(
  storage: TeleCryptIOStorage,
  folderId: string,
  fileId: string,
  name: string,
): Promise<RenameResult> {
  const tree = await resolveTree(storage, folderId);
  const branch = await resolveFile(tree, fileId);
  await branch.setName(name);
  return { id: fileId, name };
}

export async function deleteFile(
  storage: TeleCryptIOStorage,
  folderId: string,
  fileId: string,
): Promise<DeleteResult> {
  const tree = await resolveTree(storage, folderId);
  const branch = await resolveFile(tree, fileId);
  await branch.delete();
  return { id: fileId, deleted: true };
}

export async function uploadFile(
  storage: TeleCryptIOStorage,
  folderId: string,
  name: string,
  bytes: Uint8Array,
  mimetype: string,
): Promise<FileInfo> {
  const tree = await resolveTree(storage, folderId);
  const fileId = await storage.uploadFile(tree, name, toArrayBuffer(bytes), mimetype);
  return { id: fileId, name, mimetype };
}

export async function downloadFile(
  storage: TeleCryptIOStorage,
  folderId: string,
  fileId: string,
): Promise<DownloadedFile> {
  const tree = await resolveTree(storage, folderId);
  const branch = await resolveFile(tree, fileId);
  let result;
  try {
    result = await storage.downloadFile(branch);
  } catch (err) {
    throw new CliError(`download failed: ${(err as Error).message}`);
  }
  return {
    bytes: new Uint8Array(result.data),
    mimetype: result.mimetype,
    name: branch.getName(),
  };
}

export async function setupRecovery(storage: TeleCryptIOStorage): Promise<RecoverySetup> {
  return storage.keys.setupRecovery();
}

export async function restoreRecovery(
  storage: TeleCryptIOStorage,
  recoveryKey: string,
): Promise<RecoveryRestore> {
  return storage.keys.restoreFromRecoveryKey(recoveryKey);
}

function tsToIso(ts: number | undefined | null): string | null {
  if (ts == null || !Number.isFinite(ts)) return null;
  return new Date(ts).toISOString();
}

export async function getFileDetails(
  storage: TeleCryptIOStorage,
  folderId: string,
  fileId: string,
): Promise<FileDetails> {
  const tree = await resolveTree(storage, folderId);
  const branch = await resolveFile(tree, fileId);
  const name = branch.getName();
  let mimetype: string | null = null;
  let size: number | null = null;
  let createdAt: string | null = null;
  let updatedAt: string | null = null;

  try {
    const { info } = await branch.getFileInfo();
    if (info) {
      if (typeof info["mimetype"] === "string") mimetype = info["mimetype"];
      if (typeof info["size"] === "number") size = info["size"];
    }
  } catch {
    // Partial metadata is fine — UI shows "—" for unknown fields.
  }

  try {
    const event = await branch.getFileEvent();
    const content = event.getContent();
    const infoBlock = content["info"] as Record<string, unknown> | undefined;
    if (!mimetype && typeof infoBlock?.["mimetype"] === "string") {
      mimetype = infoBlock["mimetype"];
    }
    if (size == null && typeof infoBlock?.["size"] === "number") {
      size = infoBlock["size"];
    }
    const eventAny = event as { getTs?: () => number; origin_server_ts?: number };
    const ts = eventAny.getTs?.() ?? eventAny.origin_server_ts;
    createdAt = tsToIso(ts);
    updatedAt = createdAt;
  } catch {
    // Same as above.
  }

  return { name, mimetype, size, createdAt, updatedAt };
}

export async function getFolderDetails(
  storage: TeleCryptIOStorage,
  folderId: string,
): Promise<FolderDetails> {
  const tree = await resolveTree(storage, folderId);
  const client = storage.getClient();
  const room = client.getRoom(folderId);
  let createdAt: string | null = null;
  let memberCount: number | null = null;

  if (room) {
    const createEvent = room.currentState?.getStateEvents("m.room.create", "");
    createdAt = tsToIso(createEvent?.getTs());
    try {
      memberCount = room.getJoinedMemberCount();
    } catch {
      memberCount = null;
    }
  }

  return {
    name: tree.room.name || roomDisplayName(storage, folderId),
    id: folderId,
    createdAt,
    memberCount,
  };
}
