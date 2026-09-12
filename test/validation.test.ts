import { describe, expect, it } from "vitest";
import { isValidName, validateName } from "../src/index.js";

describe("name contract", () => {
  it("accepts the full remote name contract, including path-like labels", () => {
    expect(isValidName("folder/file.txt")).toBe(true);
  });

  it("rejects empty and control-character names", () => {
    expect(isValidName("")).toBe(false);
    expect(isValidName("bad\u0000name")).toBe(false);
    expect(() => validateName("bad\u0000name", "name")).toThrow("invalid name");
  });
});
