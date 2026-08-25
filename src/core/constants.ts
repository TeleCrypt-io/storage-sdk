/** Maximum plaintext media body accepted by the non-streaming SDK surface. */
export const MAX_MEDIA_FILE_BYTES = 128 * 1024 * 1024;

/** Matrix's canonical identifier bounds used at authenticated-client boundaries. */
export const MAX_MATRIX_USER_ID_BYTES = 255;
export const MAX_MATRIX_DEVICE_ID_LENGTH = 128;
export const MAX_MATRIX_IDENTIFIER_LENGTH = 512;

const MATRIX_SERVER_NAME_PATTERN = "(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9.-]+)(?::\\d{1,5})?";
const MATRIX_SERVER_NAME_REGEXP = new RegExp(`^${MATRIX_SERVER_NAME_PATTERN}$`);
const MATRIX_USER_ID_PATTERN = new RegExp(`^@([A-Za-z0-9._=+\\-/]+):(${MATRIX_SERVER_NAME_PATTERN})$`);
const MATRIX_DEVICE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const MATRIX_ROOM_ID_PATTERN = new RegExp(`^![A-Za-z0-9._~+\\/-]+:${MATRIX_SERVER_NAME_PATTERN}$`);
const MATRIX_EVENT_ID_PATTERN = /^\$[A-Za-z0-9._~:/+\-]{1,511}$/;

/**
 * Validates a new/current Matrix identity and binds its server name exactly to
 * the caller's independently trusted Matrix topology. The Matrix server name
 * is deliberately explicit: a deployment may expose its homeserver through a
 * backend hostname that differs from the user-visible Matrix server name.
 */
export function validateCanonicalMatrixUserId(value: unknown, serverName: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength > MAX_MATRIX_USER_ID_BYTES
  ) {
    throw new Error("invalid Matrix user ID");
  }
  if (typeof serverName !== "string" || !MATRIX_SERVER_NAME_REGEXP.test(serverName)) {
    throw new Error("invalid Matrix server name");
  }
  const match = value.match(MATRIX_USER_ID_PATTERN);
  if (!match || match[2].toLowerCase() !== serverName.toLowerCase()) {
    throw new Error("invalid Matrix user ID for this homeserver");
  }
  return value;
}

export function validateMatrixDeviceId(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_MATRIX_DEVICE_ID_LENGTH || !MATRIX_DEVICE_ID_PATTERN.test(value)) {
    throw new Error("invalid Matrix device ID");
  }
  return value;
}

export function validateMatrixRoomId(value: unknown, name = "room ID"): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_MATRIX_IDENTIFIER_LENGTH ||
    !MATRIX_ROOM_ID_PATTERN.test(value)
  ) {
    throw new Error(`invalid Matrix ${name}`);
  }
  return value;
}

export function validateMatrixEventId(value: unknown, name = "event ID"): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_MATRIX_IDENTIFIER_LENGTH ||
    !MATRIX_EVENT_ID_PATTERN.test(value)
  ) {
    throw new Error(`invalid Matrix ${name}`);
  }
  return value;
}
