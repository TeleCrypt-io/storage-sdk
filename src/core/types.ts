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
  mimetype?: string;
}

export interface Member {
  userId: string;
  role: string;
  membership: string;
}

export interface ShareResult {
  vaultId: string;
  userId: string;
  role: string;
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

/** One atomic recovery topology snapshot used to decide whether setup is safe. */
export interface RecoveryStatus {
  state: "unconfigured" | "ready" | "partial";
  crossSigning: {
    publicKeysOnDevice: boolean;
    privateKeysCachedLocally: boolean;
    privateKeysInSecretStorage: boolean;
  };
  secretStorage: {
    ready: boolean;
    defaultKeyId: string | null;
  };
  backupVersion: string | null;
}

export interface FileDetails {
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
