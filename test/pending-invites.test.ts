import { describe, expect, it } from "vitest";
import {
  EventType,
  UNSTABLE_MSC3088_ENABLED,
  UNSTABLE_MSC3088_PURPOSE,
  UNSTABLE_MSC3089_TREE_SUBTYPE,
} from "matrix-js-sdk";
import { listPendingInvites } from "../src/core/operations.js";
import type { TeleCryptIOStorage, TreeSpace } from "../src/TeleCryptIOStorage.js";

function invite(roomId: string): { roomId: string; getMyMembership: () => string } {
  return { roomId, getMyMembership: () => "invite" };
}

function tree(id: string, name: string, isTopLevel: boolean): TreeSpace {
  return { id, isTopLevel, room: { name } } as TreeSpace;
}

describe("pending invites", () => {
  it("does not surface nested folder invitations as root vaults", async () => {
    const rooms = [invite("!nested:example.test"), invite("!top:example.test")];
    const trees = new Map([
      [rooms[0].roomId, tree(rooms[0].roomId, "Nested folder", false)],
      [rooms[1].roomId, tree(rooms[1].roomId, "Top-level vault", true)],
    ]);
    const client = {
      getRooms: () => rooms,
      getRoom: () => undefined,
      getUserId: () => null,
    };
    const storage = {
      getClient: () => client,
      getTree: (roomId: string) => trees.get(roomId),
    } as unknown as TeleCryptIOStorage;

    await expect(listPendingInvites(storage)).resolves.toEqual([
      { id: "!top:example.test", name: "Top-level vault" },
    ]);
  });

  it("requires the enabled data-tree purpose marker instead of generic m.space", async () => {
    const generic = {
      ...invite("!generic-space:example.test"),
      currentState: {
        getStateEvents: (type: string) =>
          type === EventType.RoomCreate ? { getContent: () => ({ type: "m.space" }) } : null,
      },
    };
    const disabled = {
      ...invite("!disabled-tree:example.test"),
      currentState: {
        getStateEvents: (type: string, stateKey: string) => {
          if (type === EventType.RoomCreate) return { getContent: () => ({ type: "m.space" }) };
          if (
            type === UNSTABLE_MSC3088_PURPOSE.name &&
            stateKey === UNSTABLE_MSC3089_TREE_SUBTYPE.name
          ) {
            return { getContent: () => ({ [UNSTABLE_MSC3088_ENABLED.name]: false }) };
          }
          return null;
        },
      },
    };
    const wrongSubtype = {
      ...invite("!wrong-subtype:example.test"),
      currentState: {
        getStateEvents: (type: string, stateKey: string) => {
          if (type === EventType.RoomCreate) return { getContent: () => ({ type: "m.space" }) };
          if (type === UNSTABLE_MSC3088_PURPOSE.name && stateKey === "org.example.other") {
            return { getContent: () => ({ [UNSTABLE_MSC3088_ENABLED.name]: true }) };
          }
          return null;
        },
      },
    };
    const reviewed = {
      ...invite("!reviewed-tree:example.test"),
      currentState: {
        getStateEvents: (type: string, stateKey: string) => {
          if (type === EventType.RoomCreate) return { getContent: () => ({ type: "m.space" }) };
          if (
            type === UNSTABLE_MSC3088_PURPOSE.name &&
            stateKey === UNSTABLE_MSC3089_TREE_SUBTYPE.name
          ) {
            return {
              getContent: () => ({ [UNSTABLE_MSC3088_ENABLED.name]: true }),
            };
          }
          return null;
        },
      },
    };
    const client = {
      getRooms: () => [generic, disabled, wrongSubtype, reviewed],
      getRoom: () => undefined,
      getUserId: () => null,
    };
    const storage = {
      getClient: () => client,
      getTree: () => undefined,
    } as unknown as TeleCryptIOStorage;

    await expect(listPendingInvites(storage)).resolves.toEqual([
      { id: reviewed.roomId, name: reviewed.roomId },
    ]);
  });

  it("does not surface an invited folder with an active space parent", async () => {
    const nestedInvite = {
      ...invite("!nested-parent:example.test"),
      currentState: {
        getStateEvents: (type: string) =>
          type === EventType.SpaceParent
            ? { getContent: () => ({ via: ["example.test"] }) }
            : null,
      },
    };
    const client = {
      getRooms: () => [nestedInvite],
      getRoom: () => undefined,
      getUserId: () => null,
    };
    const storage = {
      getClient: () => client,
      getTree: () => ({ id: nestedInvite.roomId, isTopLevel: true, room: { name: "Nested" } }),
    } as unknown as TeleCryptIOStorage;

    await expect(listPendingInvites(storage)).resolves.toEqual([]);
  });
});
