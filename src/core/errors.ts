/** A user-facing operation error: a clean, prefix-free message meant to be
 * shown directly to a user — never a raw stack trace. Thrown for expected failure
 * conditions (bad login, wrong recovery key, missing file, vault, or folder, not
 * logged in, ...). Platform-agnostic: no Node/CLI dependencies. */
export class StorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
  }
}

/** Setup would replace account recovery state, which this SDK never does. */
export class RecoveryAlreadyConfiguredError extends StorageError {
  readonly code = "RECOVERY_ALREADY_CONFIGURED" as const;

  constructor() {
    super(
      "recovery is already configured for this account; use the existing Recovery Key or restore it on this device",
    );
    this.name = "RecoveryAlreadyConfiguredError";
  }
}

/** Restore failed without exposing provider or crypto-library error details. */
export class RecoveryRestoreError extends StorageError {
  readonly code = "RECOVERY_RESTORE_FAILED" as const;

  constructor(cause?: unknown) {
    super(
      "recovery restore failed; verify the Recovery Key and account",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RecoveryRestoreError";
  }
}

/** Setup failed before the generated Recovery Key could be safely returned. */
export class RecoverySetupError extends StorageError {
  readonly code = "RECOVERY_SETUP_FAILED" as const;

  constructor(cause?: unknown) {
    super(
      "recovery setup did not complete; check recovery status before retrying",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RecoverySetupError";
  }
}

/** The recovery setup transport result is ambiguous; state must be checked before retrying. */
export class RecoverySetupAmbiguousError extends StorageError {
  readonly code = "RECOVERY_SETUP_AMBIGUOUS" as const;

  constructor(cause?: unknown) {
    super(
      "recovery setup may have completed; check recovery status before retrying",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RecoverySetupAmbiguousError";
  }
}

/** Recovery restore was cancelled after the provider may have changed state. */
export class RecoveryRestoreAmbiguousError extends StorageError {
  readonly code = "RECOVERY_RESTORE_AMBIGUOUS" as const;

  constructor(cause?: unknown) {
    super(
      "recovery restore may have completed; check recovery status before retrying",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RecoveryRestoreAmbiguousError";
  }
}

/** A Matrix mutation was cancelled after its request started. */
export class MutationOutcomeUnknownError extends StorageError {
  readonly code = "MUTATION_OUTCOME_UNKNOWN" as const;
  readonly operation: string;

  constructor(operation = "operation", options?: ErrorOptions) {
    super(`${operation} outcome is unknown; reconcile current state before retrying`, options);
    this.name = "MutationOutcomeUnknownError";
    this.operation = operation;
  }
}

/** A multi-room mutation committed some work before a later step failed. */
export class MutationPartialError extends StorageError {
  readonly code = "MUTATION_PARTIAL" as const;
  readonly operation: string;
  readonly completedIds: readonly string[];

  constructor(
    operation: string,
    completedIds: readonly string[],
    detail?: string,
    options?: ErrorOptions,
  ) {
    super(
      `${operation} failed after partial completion${detail ? `: ${detail}` : ""}; retry to reconcile current state`,
      options,
    );
    this.name = "MutationPartialError";
    this.operation = operation;
    this.completedIds = [...completedIds];
  }
}

/** A vault or folder still contains files or child folders. */
export class NonEmptyTreeError extends StorageError {
  readonly code = "NON_EMPTY_TREE" as const;
  readonly treeId: string;

  constructor(treeId: string) {
    super("cannot delete a nonempty vault or folder; delete its files and empty child folders first");
    this.name = "NonEmptyTreeError";
    this.treeId = treeId;
  }
}

/** Room creation timed out or returned an unusable identity. */
export class RoomCreationAmbiguousError extends StorageError {
  readonly code = "ROOM_CREATION_AMBIGUOUS" as const;
  readonly operation: string;

  constructor(operation = "room creation", cause?: unknown) {
    super(
      `${operation} outcome is unknown; reconcile newly-created rooms before retrying`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "RoomCreationAmbiguousError";
    this.operation = operation;
  }
}

/** A newly-created room could not be fully rolled back. */
export class RoomCleanupIncompleteError extends StorageError {
  readonly code = "ROOM_CLEANUP_INCOMPLETE" as const;
  readonly roomId: string;

  constructor(roomId: string, cause?: unknown) {
    super(
      "created room cleanup is incomplete; retry cleanup for the created room",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RoomCleanupIncompleteError";
    this.roomId = roomId;
  }
}

/** The SDK's single product file-size limit was exceeded. */
export class FileTooLargeError extends StorageError {
  readonly code = "FILE_TOO_LARGE" as const;

  constructor() {
    super("file exceeds the 128 MiB limit");
    this.name = "FileTooLargeError";
  }
}

/** The file event is present, but this device has no key to decrypt it. */
export class UndecryptableFileError extends StorageError {
  readonly code = "FILE_UNDECRYPTABLE" as const;

  constructor() {
    super(
      "downloadFile: could not read file info from the event — it is likely undecryptable on this device (missing megolm session; try restoring from a Recovery Key)",
    );
    this.name = "UndecryptableFileError";
  }
}
