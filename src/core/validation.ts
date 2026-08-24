/** Small shared input validators kept out of the public core barrel. */

export const MAX_NAME_LENGTH = 512;

export function validateName(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`invalid ${label}`);
  }
}
