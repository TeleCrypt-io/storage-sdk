/** The typed result contract for every `core/operations.ts` function. */

export interface VaultInfo {
  id: string;
  name: string;
}

/** A nested directory node inside a vault. */
export interface FolderInfo {
  id: string;
  name: string;
}

export interface FileInfo {
  id: string;
  name: string;
  ownerUserId: string;
  mimetype?: string;
}

/** File listing information paired with current native room action availability. */
export interface ListedFileInfo extends FileInfo {
  canRename: boolean;
  canDelete: boolean;
}

export interface Member {
  userId: string;
  role: string;
  membership: string;
}

export type TreeRole = "viewer" | "editor" | "owner";

/** Current native Matrix capabilities for actions in a tree room. */
export interface TreeActionCapabilities {
  renameTree: boolean;
  uploadFile: boolean;
  renameFile: boolean;
  createSubfolder: boolean;
  deleteTree: boolean;
  inviteMembers: boolean;
}

/** Current native Matrix capabilities for actions against one room member. */
export interface MemberActionCapabilities {
  canShare: Record<TreeRole, boolean>;
  canChangeRole: Record<TreeRole, boolean>;
  canUnshare: boolean;
}

export interface ShareResult {
  vaultId: string;
  userId: string;
  role: TreeRole;
  rootMembership: string;
}

export interface UnshareResult {
  vaultId: string;
  userId: string;
  removed: boolean;
}

export interface JoinResult {
  vaultId: string;
  joined: boolean;
}

export interface DeleteResult {
  id: string;
  deleted: boolean;
}

export interface RenameResult {
  id: string;
  name: string;
  backupTarget?: { treeId: string; fileId?: string; metadataEventId?: string };
}

/** Bytes in/out are always `Uint8Array` — never a file path. */
export interface DownloadedFile {
  bytes: Uint8Array;
  mimetype: string;
  name: string;
}

export interface FileDetails {
  ownerUserId: string;
  name: string;
  mimetype: string | null;
  size: number | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface VaultDetails {
  name: string;
  id: string;
  createdAt: string | null;
  memberCount: number | null;
}

/** Details for a nested directory node inside a vault. */
export interface FolderDetails {
  name: string;
  id: string;
  createdAt: string | null;
  memberCount: number | null;
}

export type { KeySafeStatus, KeySafeOptions } from "../key-safe.js";
