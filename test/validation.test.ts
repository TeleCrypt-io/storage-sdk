import { describe, expect, it } from "vitest";
import { isValidName, MAX_NAME_LENGTH, validateName } from "../src/index.js";

describe("name contract", () => {
  it("accepts the full remote name contract, including path-like labels", () => {
    expect(isValidName("folder/file.txt")).toBe(true);
    expect(isValidName("x".repeat(MAX_NAME_LENGTH))).toBe(true);
  });

  it("rejects empty, control-character, and oversized names", () => {
    expect(isValidName("")).toBe(false);
    expect(isValidName("bad\u0000name")).toBe(false);
    expect(isValidName("x".repeat(MAX_NAME_LENGTH + 1))).toBe(false);
    expect(() => validateName("bad\u0000name", "name")).toThrow("invalid name");
  });
});
