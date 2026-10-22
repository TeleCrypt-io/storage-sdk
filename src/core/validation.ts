import {
  EventType,
  RoomCreateTypeField,
  RoomType,
  UNSTABLE_MSC3088_ENABLED,
  UNSTABLE_MSC3088_PURPOSE,
  UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "matrix-js-sdk";

/** Shared name contract used by SDK inputs and remote projections. */

export function isValidName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function validateName(value: unknown, label: string): asserts value is string {
  if (!isValidName(value)) {
    throw new Error(`invalid ${label}`);
  }
}

export const STORAGE_ROOM_ENCRYPTION_ALGORITHM = "m.megolm.v1.aes-sha2";

interface StorageTreeRoomLike {
  currentState?: {
    getStateEvents?: (eventType: string, stateKey?: string) => unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The shared Storage-room contract for both synced rooms and refreshed state. */
export function isStorageTreeState(
  createContent: unknown,
  purposeContent: unknown,
  encryptionContent: unknown,
): boolean {
  return hasStorageTreeMarkers(createContent, purposeContent) &&
    isRecord(encryptionContent) &&
    encryptionContent.algorithm === STORAGE_ROOM_ENCRYPTION_ALGORITHM;
}

/** The room markers needed for explicit invite cleanup before encryption is available. */
export function hasStorageTreeMarkers(createContent: unknown, purposeContent: unknown): boolean {
  return (
    isRecord(createContent) &&
    createContent[RoomCreateTypeField] === RoomType.Space &&
    isRecord(purposeContent) &&
    purposeContent[UNSTABLE_MSC3088_ENABLED.name] === true
  );
}

function getStorageTreeState(room: StorageTreeRoomLike | null | undefined): {
  createContent: unknown;
  purposeContent: unknown;
  encryptionContent: unknown;
} {
  const getContent = (eventType: string, stateKey: string): unknown => {
    const raw = room?.currentState?.getStateEvents?.(eventType, stateKey);
    const event = Array.isArray(raw) ? raw[0] : raw;
    if (typeof event !== "object" || event === null) return undefined;
    const getEventContent = (event as { getContent?: unknown }).getContent;
    return typeof getEventContent === "function"
      ? getEventContent.call(event)
      : undefined;
  };

  return {
    createContent: getContent(EventType.RoomCreate, ""),
    purposeContent: getContent(UNSTABLE_MSC3088_PURPOSE.name, UNSTABLE_MSC3089_TREE_SUBTYPE.name),
    encryptionContent: getContent(EventType.RoomEncryption, ""),
  };
}

/** Checks the existing Storage markers and Megolm room encryption together. */
export function isStorageTreeRoom(room: StorageTreeRoomLike | null | undefined): boolean {
  const state = getStorageTreeState(room);
  return isStorageTreeState(state.createContent, state.purposeContent, state.encryptionContent);
}

/** Checks only the room markers for explicit cleanup paths such as declining an invite. */
export function hasStorageTreeMarkersRoom(room: StorageTreeRoomLike | null | undefined): boolean {
  const state = getStorageTreeState(room);
  return hasStorageTreeMarkers(state.createContent, state.purposeContent);
}
