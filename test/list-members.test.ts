import { describe, expect, it, vi } from "vitest";
import { TeleCryptIOStorage, type TreeSpace } from "../src/TeleCryptIOStorage.js";

describe("listMembers power-level defaults", () => {
  it("treats events_default 0 as viewer instead of editor", async () => {
    const roomId = "!members:example.test";
    const memberId = "@reader:example.test";
    const authedRequest = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith("/members")) {
        return {
          chunk: [{ state_key: memberId, content: { membership: "invite" } }],
        };
      }
      return {
        users_default: 0,
        events_default: 0,
        events: { "m.room.power_levels": 100 },
        users: {},
      };
    });
    const storage = new TeleCryptIOStorage({ http: { authedRequest } } as never);
    const tree = { id: roomId } as TreeSpace;

    await expect(storage.listMembers(tree)).resolves.toEqual([
      { userId: memberId, role: "viewer", membership: "invite" },
    ]);
  });
});
