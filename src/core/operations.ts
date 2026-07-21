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
  FileInfo,
  FolderInfo,
  JoinResult,
  Member,
  RecoveryRestore,
  RecoverySetup,
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

export async function joinFolder(storage: TeleCryptIOStorage, folderId: string): Promise<JoinResult> {
  try {
    await storage.getClient().joinRoom(folderId);
  } catch (err) {
    throw new CliError(`join failed: ${(err as Error).message}`);
  }
  return { folderId, joined: true };
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
