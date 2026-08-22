import { describe, expect, it } from "vitest";
import { newTestDeviceId } from "./harness/users.js";

describe("test device IDs", () => {
  it("generates MAS-compatible identifiers", () => {
    const deviceId = newTestDeviceId("TC");

    expect(deviceId).toMatch(/^[A-Za-z0-9-]{10,}$/);
  });
});
