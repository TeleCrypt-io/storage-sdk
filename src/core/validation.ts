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
