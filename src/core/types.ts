/**
 * The shared typed result contract for every `core/operations.ts` function.
 * This is deliberately the ONE definition of these shapes: the CLI's
 * `--json` schema is these types (or a trivial projection of them, e.g.
 * `FolderInfo.id` -> the CLI's `folderId` key for backwards-compatible
 * command output), and the future React UI's data model is these types
 * directly. Keeping it here means the CLI and the UI can never drift apart
 * on what an operation returns.
 */

export interface FolderInfo {
  id: string;
  name: string;
}

export interface FileInfo {
  id: string;
  name: string;
  mimetype?: string;
}

export interface Member {
  userId: string;
  role: string;
  membership: string;
}

export interface ShareResult {
  folderId: string;
  userId: string;
  role: string;
}

export interface UnshareResult {
  folderId: string;
  userId: string;
  removed: boolean;
}

export interface JoinResult {
  folderId: string;
  joined: boolean;
}

/** Bytes in/out are always `Uint8Array` — never a file path. */
export interface DownloadedFile {
  bytes: Uint8Array;
  mimetype: string;
  name: string;
}

export interface RecoverySetup {
  recoveryKey: string;
}

export interface RecoveryRestore {
  imported: number;
  total: number;
}
