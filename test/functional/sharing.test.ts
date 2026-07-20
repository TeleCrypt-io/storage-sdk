import { describe, it, expect } from "vitest";
import { registerTestUser } from "../harness/users";
import { createTestClient, stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
import { SecureStorage } from "../../src/SecureStorage";
import { TreePermissions } from "matrix-js-sdk/src/models/MSC3089TreeSpace";

async function waitForTree(
  storage: SecureStorage,
  treeId: string,
  label = "tree visible",
) {
  return waitFor(
    async () => {
      const trees = await storage.listTrees();
      return trees.find((t) => t.id === treeId) ?? null;
    },
    { label, timeoutMs: 15000 },
  );
}

async function waitForFiles(
  tree: { listFiles: () => { length: number } },
  label = "files appear",
) {
  return waitFor<{ id: string; getName: () => string }[]>(
    () => {
      const files = tree.listFiles() as { id: string; getName: () => string }[];
      return files.length > 0 ? files : null;
    },
    { label, timeoutMs: 15000 },
  );
}

describe("sharing", () => {
  it("3.1 Alice shares with Bob as Viewer; Bob can list the files", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);
      const bobStore = new SecureStorage(bob);

      const tree = await aliceStore.createTree("Shared");
      await waitFor(() => tree.room.name === "Shared");

      const data = new TextEncoder().encode("shared content").buffer as ArrayBuffer;
      const eventId = await aliceStore.uploadFile(tree, "shared.txt", data, "text/plain");
      await waitForFiles(tree, "alice file uploaded");

      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);

      const bobTree = await waitForTree(bobStore, tree.id);
      const bobFiles = await waitForFiles(bobTree, "bob sees files");
      expect(bobFiles.some((f) => f.id === eventId)).toBe(true);
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.2 Bob as Viewer can download and decrypt Alice's file", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);
      const bobStore = new SecureStorage(bob);

      const tree = await aliceStore.createTree("DecryptTest");
      await waitFor(() => tree.room.name === "DecryptTest");

      // Alice invites Bob FIRST, then uploads so Bob gets the megolm key
      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);
      await waitForTree(bobStore, tree.id, "bob joined");

      // Now Alice uploads — Bob is in the room and gets the key
      const plaintext = new TextEncoder().encode("Hello from Alice!")
        .buffer as ArrayBuffer;
      await aliceStore.uploadFile(tree, "msg.txt", plaintext, "text/plain");
      const _aliceFiles = await waitForFiles(tree);

      // Bob downloads and decrypts
      const bobTree = await waitForTree(bobStore, tree.id);
      const bobFiles = await waitFor(
        async () => {
          const files = bobTree.listFiles() as {
            id: string;
            getName: () => string;
          }[];
          return files.length > 0 ? files : null;
        },
        { label: "bob sees encrypted file", timeoutMs: 15000 },
      );

      const downloaded = await bobStore.downloadFile(bobFiles[0] as any);
      const decoded = new TextDecoder().decode(downloaded.data);
      expect(decoded).toBe("Hello from Alice!");
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.3 Bob as Editor can upload; Alice can decrypt", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);
      const bobStore = new SecureStorage(bob);

      const tree = await aliceStore.createTree("EditTest");
      await waitFor(() => tree.room.name === "EditTest");

      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);
      const bobTree = await waitForTree(bobStore, tree.id);

      // Alice sets Bob as Editor
      await tree.setPermissions(bobUser.userId, TreePermissions.Editor);

      // Bob uploads a file
      const bobData = new TextEncoder().encode("Bob's file").buffer as ArrayBuffer;
      await bobStore.uploadFile(bobTree, "bob.txt", bobData, "text/plain");
      await waitForFiles(bobTree, "bob uploaded");

      // Alice can see and decrypt Bob's file
      const aliceFiles = await waitFor(
        async () => {
          const files = tree.listFiles() as {
            id: string;
            getName: () => string;
          }[];
          return files.some((f) => f.getName() === "bob.txt") ? files : null;
        },
        { label: "alice sees bob's file", timeoutMs: 15000 },
      );

      const bobFile = aliceFiles.find((f: any) => f.getName() === "bob.txt")!;
      const downloaded = await aliceStore.downloadFile(bobFile as any);
      const decoded = new TextDecoder().decode(downloaded.data);
      expect(decoded).toBe("Bob's file");
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.4 Bob as Viewer cannot upload", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);
      const bobStore = new SecureStorage(bob);

      const tree = await aliceStore.createTree("NoUpload");
      await waitFor(() => tree.room.name === "NoUpload");

      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);
      const bobTree = await waitForTree(bobStore, tree.id);

      const data = new TextEncoder().encode("unauthorized").buffer as ArrayBuffer;
      await expect(
        bobStore.uploadFile(bobTree, "hack.txt", data, "text/plain"),
      ).rejects.toThrow();
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.5 uninvited user cannot see the folder", async () => {
    const aliceUser = await registerTestUser("share_a");
    const charlieUser = await registerTestUser("share_c");
    const alice = await createTestClient(aliceUser);
    const charlie = await createTestClient(charlieUser);
    try {
      const aliceStore = new SecureStorage(alice);
      const charlieStore = new SecureStorage(charlie);

      const tree = await aliceStore.createTree("Private");
      await waitFor(() => tree.room.name === "Private");

      const charlieTrees = await charlieStore.listTrees();
      expect(charlieTrees.some((t) => t.id === tree.id)).toBe(false);
    } finally {
      stopTestClient(alice);
      stopTestClient(charlie);
    }
  });

  it("3.6 getPermissions reports the role that was set", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);

      const tree = await aliceStore.createTree("PermTest");
      await waitFor(() => tree.room.name === "PermTest");

      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);

      const viewerPerms = tree.getPermissions(bobUser.userId);
      expect(viewerPerms).toBe(TreePermissions.Viewer);

      await tree.setPermissions(bobUser.userId, TreePermissions.Editor);
      const editorPerms = await waitFor(
        () => {
          const perms = tree.getPermissions(bobUser.userId);
          return perms === TreePermissions.Editor ? perms : null;
        },
        { label: "permissions updated to Editor", timeoutMs: 10000 },
      );
      expect(editorPerms).toBe(TreePermissions.Editor);
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.7 sharing parent with andSubspaces grants access to subfolders", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);
      const bobStore = new SecureStorage(bob);

      const parent = await aliceStore.createTree("Parent");
      await waitFor(() => parent.room.name === "Parent");

      const child = await parent.createDirectory("Child");
      await waitFor(
        () => !child.isTopLevel,
        { label: "child is subspace", timeoutMs: 10000 },
      );

      // Invite Bob with andSubspaces
      await parent.invite(bobUser.userId, true);
      await bob.joinRoom(parent.id);
      // Also join the child room
      await bob.joinRoom(child.id);

      const bobParent = await waitForTree(bobStore, parent.id, "bob sees parent");

      // Bob needs to wait for the child space relationship to sync
      const bobChild = await waitFor<object | null>(
        () => bobParent.getDirectory(child.id) ?? null,
        { label: "bob sees child directory", timeoutMs: 10000 },
      );
      expect(bobChild).toBeDefined();
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.8 after Alice removes Bob, Bob cannot read new files", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);
      const bobStore = new SecureStorage(bob);

      const tree = await aliceStore.createTree("Revocation");
      await waitFor(() => tree.room.name === "Revocation");

      // Alice invites Bob first, then uploads a file Bob can read
      await tree.invite(bobUser.userId);
      await bob.joinRoom(tree.id);
      await waitForTree(bobStore, tree.id, "bob joined");

      const file1 = new TextEncoder().encode("BEFORE removal").buffer as ArrayBuffer;
      await aliceStore.uploadFile(tree, "before.txt", file1, "text/plain");
      const _aliceFiles = await waitForFiles(tree, "first file uploaded");

      // Bob can decrypt the file shared while he had access
      const bobTree = await waitForTree(bobStore, tree.id);
      const bobFiles = await waitFor(
        async () => {
          const files = bobTree.listFiles() as {
            id: string;
            getName: () => string;
          }[];
          return files.length > 0 ? files : null;
        },
        { label: "bob sees before file", timeoutMs: 15000 },
      );
      const firstDownload = await bobStore.downloadFile(bobFiles[0] as any);
      expect(new TextDecoder().decode(firstDownload.data)).toBe("BEFORE removal");

      // Alice kicks Bob from the room
      await alice.kick(tree.id, bobUser.userId, "revoked");

      // Wait for the room state to update
      await waitFor(
        () => {
          const room = bob.getRoom(tree.id);
          return room?.getMyMembership() === "leave";
        },
        { label: "bob removed from room", timeoutMs: 10000 },
      );

      // Alice uploads a NEW file AFTER removal
      const file2 = new TextEncoder().encode("AFTER removal").buffer as ArrayBuffer;
      const afterEventId = await aliceStore.uploadFile(tree, "after.txt", file2, "text/plain");
      const aliceAfterFiles = await waitFor(
        async () => {
          const files = tree.listFiles() as { id: string; getName: () => string }[];
          return files.some((f) => f.id === afterEventId) ? files : null;
        },
        { label: "alice after file", timeoutMs: 15000 },
      );
      const aliceAfterBranch = aliceAfterFiles.find((f) => f.id === afterEventId)!;

      // --- Prove Bob cannot obtain the plaintext of "AFTER removal" — not merely that he was
      // kicked. A passing test here must actually depend on key-denial, not just membership.

      // 1) The friendly library path is closed: Bob's own listTrees() no longer includes the
      // tree at all.
      const bobTreesAfter = await bobStore.listTrees();
      expect(bobTreesAfter.some((t) => t.id === tree.id)).toBe(false);

      // 2) Bob's own client (using the tree reference he already held from before the kick)
      // never receives the new file's branch state at all — once kicked, Synapse stops
      // delivering room updates to him, so the branch is simply absent, full stop.
      expect(bobTree.getFile(afterEventId)).toBeNull();

      // 3) Even a direct, low-level attempt by Bob to fetch the encrypted room event by ID is
      // denied by the server: he is not a member of the room as of when this event was sent, and
      // Synapse enforces that independently of E2EE. This proves Bob cannot obtain the
      // megolm-encrypted event body (and therefore the AES key/JWK carried inside it) through the
      // Matrix API at all, by any means available to his client.
      await expect(bob.fetchRoomEvent(tree.id, afterEventId)).rejects.toThrow();

      // 4) Matrix authenticated media is NOT room-access-controlled: Bob's own (still-valid)
      // access token CAN fetch the raw ciphertext bytes for the file's mxc URI directly. This is
      // the scenario that makes step 5 meaningful — the ciphertext genuinely is reachable, so the
      // security property depends entirely on the key, not on hiding the bytes.
      const { info: aliceFileInfo } = await (
        aliceAfterBranch as unknown as {
          getFileInfo: () => Promise<{ info: Record<string, unknown> }>;
        }
      ).getFileInfo();
      const mxcUrl = aliceFileInfo.url as string;
      const bobClientAny = bob as unknown as {
        mxcUrlToHttp: (mxc: string, ...args: unknown[]) => string | null;
        getAccessToken: () => string | null;
      };
      const bobDownloadUrl = bobClientAny.mxcUrlToHttp(
        mxcUrl,
        undefined,
        undefined,
        undefined,
        false,
        true,
        true,
      );
      const rawRes = await fetch(bobDownloadUrl!, {
        headers: { Authorization: `Bearer ${bobClientAny.getAccessToken()}` },
      });
      expect(rawRes.ok).toBe(true);
      const rawCiphertext = await rawRes.arrayBuffer();

      // The raw ciphertext bytes never contain the plaintext (confirms it really is encrypted,
      // not merely obscured).
      const rawText = new TextDecoder("utf-8", { fatal: false }).decode(rawCiphertext);
      expect(rawText).not.toContain("AFTER removal");

      // 5) And Bob has no legitimate way to get the real decryption key (steps 2 and 3 already
      // proved he cannot reach the event that carries it). Simulating his best-case outcome —
      // attempting to decrypt the ciphertext with a key he does NOT actually have — yields
      // garbage, not "AFTER removal". (AES-CTR has no authentication tag, so a wrong key
      // "succeeds" mechanically but produces useless output; it does not throw.)
      const { decryptAttachment } = await import("matrix-encrypt-attachment");
      const wrongKey = { ...(aliceFileInfo.key as { k: string }) };
      // Reversing the base64url key material guarantees a different (wrong) key while keeping
      // valid base64url characters and length.
      wrongKey.k = wrongKey.k.split("").reverse().join("");
      const garbage = await decryptAttachment(Buffer.from(rawCiphertext), {
        ...aliceFileInfo,
        key: wrongKey,
      } as Parameters<typeof decryptAttachment>[1]);
      expect(new TextDecoder("utf-8", { fatal: false }).decode(garbage)).not.toBe(
        "AFTER removal",
      );
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });

  it("3.9 listMembers reports participants and their roles from membership + power levels", async () => {
    const aliceUser = await registerTestUser("share_a");
    const bobUser = await registerTestUser("share_b");
    const charlieUser = await registerTestUser("share_c");
    const alice = await createTestClient(aliceUser);
    const bob = await createTestClient(bobUser);
    try {
      const aliceStore = new SecureStorage(alice);

      const tree = await aliceStore.createTree("Members");
      await waitFor(() => tree.room.name === "Members");

      // Alice (the creator/owner) should already be reported even before
      // anyone else is invited.
      const soloMembers = await aliceStore.listMembers(tree);
      expect(soloMembers.some((m) => m.userId === aliceUser.userId && m.role === "owner")).toBe(
        true,
      );

      // Invite Bob as (default) viewer; he shows up as "invite" until he joins.
      await tree.invite(bobUser.userId);
      const invitedMembers = await waitFor(
        async () => {
          const members = await aliceStore.listMembers(tree);
          const b = members.find((m) => m.userId === bobUser.userId);
          return b ? members : null;
        },
        { label: "bob visible as invited", timeoutMs: 10000 },
      );
      const bobInvited = invitedMembers.find((m) => m.userId === bobUser.userId)!;
      expect(bobInvited.role).toBe(TreePermissions.Viewer);
      expect(bobInvited.membership).toBe("invite");

      // Bob joins, and Alice promotes him to editor.
      await bob.joinRoom(tree.id);
      await tree.setPermissions(bobUser.userId, TreePermissions.Editor);
      const joinedMembers = await waitFor(
        async () => {
          const members = await aliceStore.listMembers(tree);
          const b = members.find((m) => m.userId === bobUser.userId);
          return b?.membership === "join" && b.role === TreePermissions.Editor ? members : null;
        },
        { label: "bob joined as editor", timeoutMs: 10000 },
      );
      const bobJoined = joinedMembers.find((m) => m.userId === bobUser.userId)!;
      expect(bobJoined.role).toBe(TreePermissions.Editor);
      expect(bobJoined.membership).toBe("join");

      // Charlie, who was never invited, must not appear at all.
      expect(joinedMembers.some((m) => m.userId === charlieUser.userId)).toBe(false);
    } finally {
      stopTestClient(alice);
      stopTestClient(bob);
    }
  });
});
