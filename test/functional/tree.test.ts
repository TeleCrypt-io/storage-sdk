// 1.10 restarts a client with the same persistent crypto store. Node has no
// native IndexedDB, so provide the same per-file polyfill as versions.test.
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { registerTestUser } from "../harness/users";
import { createTestClient, stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
import { TeleCryptIOStorage, MSC3089TreeSpace } from "../../src/TeleCryptIOStorage";

async function waitForName(
  tree: MSC3089TreeSpace,
  expected: string,
  label = "name propagates",
): Promise<void> {
  await waitFor(() => tree.room.name === expected, { label, timeoutMs: 10000 });
}

describe("tree operations", () => {
  it("1.1 creates a top-level vault with correct name and isTopLevel", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("My Vault");
      expect(tree.id).toBeTruthy();
      expect(typeof tree.id).toBe("string");
      await waitForName(tree, "My Vault", "initial name");
      expect(tree.isTopLevel).toBe(true);
    } finally {
      stopTestClient(client);
    }
  });

  it("1.2 creates a subfolder visible in getDirectories", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const root = await storage.createTree("Root");
      await waitForName(root, "Root");

      const sub = await root.createDirectory("Sub");

      // Wait for the parent state event to arrive so isTopLevel flips
      await waitFor(() => sub.isTopLevel === false, {
        label: "subfolder is not top-level",
        timeoutMs: 10000,
      });

      const dirs = root.getDirectories();
      expect(dirs.some((d) => d.id === sub.id)).toBe(true);
    } finally {
      stopTestClient(client);
    }
  });

  it("1.2b createSubtree links the child even when sync lags", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const root = await storage.createTree("Root");
      await waitForName(root, "Root");

      // createSubtree must return a usable tree and leave the exact
      // space.child link visible after its authoritative state refresh.
      const sub = await storage.createSubtree(root, "Linked");
      expect(sub.id).toBeTruthy();

      await waitFor(() => sub.isTopLevel === false, {
        label: "subfolder is not top-level (linked)",
        timeoutMs: 10000,
      });

      const dirs = root.getDirectories();
      expect(dirs.some((d) => d.id === sub.id)).toBe(true);

      // The child must be reachable from the parent via the space.child
      // state event — the exact thing that was missing when the race hit.
      const childEvents = root.room.currentState.getStateEvents("m.space.child");
      expect(childEvents.some((e) => e.getStateKey() === sub.id)).toBe(true);
    } finally {
      stopTestClient(client);
    }
  });

  it("1.3 creates nested folders three deep, hierarchy walkable", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const l1 = await storage.createTree("L1");
      await waitForName(l1, "L1");

      const l2 = await l1.createDirectory("L2");
      await waitFor(() => l2.isTopLevel === false, {
        label: "L2 is not top-level",
      });

      const l3 = await l2.createDirectory("L3");
      await waitFor(() => l3.isTopLevel === false, {
        label: "L3 is not top-level",
      });

      expect(l1.isTopLevel).toBe(true);
      expect(l2.isTopLevel).toBe(false);
      expect(l3.isTopLevel).toBe(false);

      const fromL1 = l1.getDirectories();
      expect(fromL1.some((d) => d.id === l2.id)).toBe(true);

      const fromL2 = l2.getDirectories();
      expect(fromL2.some((d) => d.id === l3.id)).toBe(true);
    } finally {
      stopTestClient(client);
    }
  });

  it("1.4 rename a vault is visible after sync", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("Original");
      await waitForName(tree, "Original");

      await tree.setName("Renamed");
      await waitForName(tree, "Renamed", "rename propagates");
      expect(tree.room.name).toBe("Renamed");
    } finally {
      stopTestClient(client);
    }
  });

  it("1.5 delete a subfolder removes it from getDirectories", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const root = await storage.createTree("Root");
      await waitForName(root, "Root");

      const sub = await root.createDirectory("Sub");
      await waitFor(() => sub.isTopLevel === false, {
        label: "subfolder created for delete test",
      });

      const before = root.getDirectories();
      expect(before.some((d) => d.id === sub.id)).toBe(true);

      await sub.delete();

      // Wait for the space child event to be removed locally
      await waitFor(
        () => !root.getDirectories().some((d) => d.id === sub.id),
        { label: "subfolder removed from parent", timeoutMs: 10000 },
      );

      const after = root.getDirectories();
      expect(after.some((d) => d.id === sub.id)).toBe(false);
    } finally {
      stopTestClient(client);
    }
  });

  it("1.6 getDirectory returns correct folder, unknown ID returns undefined", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const root = await storage.createTree("Root");
      await waitForName(root, "Root");

      const sub = await root.createDirectory("Sub");
      await waitFor(() => sub.isTopLevel === false, {
        label: "subfolder created for getDirectory test",
      });

      const found = root.getDirectory(sub.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(sub.id);

      const missing = root.getDirectory("!nonexistent:localhost:8008");
      expect(missing).toBeUndefined();
    } finally {
      stopTestClient(client);
    }
  });

  it("1.7 getOrder and setOrder work", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const root = await storage.createTree("Root");
      await waitForName(root, "Root");

      const a = await root.createDirectory("A");
      const b = await root.createDirectory("B");

      // Wait for both to have parent state
      await waitFor(() => a.isTopLevel === false, {
        label: "A is not top-level",
      });
      await waitFor(() => b.isTopLevel === false, {
        label: "B is not top-level",
      });

      await b.setOrder(0);
      await waitFor(() => b.getOrder() === 0, {
        label: "order set to 0",
        timeoutMs: 10000,
      });

      const dirs = root.getDirectories();
      const bAfter = dirs.find((d) => d.id === b.id)!;
      expect(bAfter.getOrder()).toBe(0);
    } finally {
      stopTestClient(client);
    }
  });

  it("1.8 creating a folder with empty name is rejected before room creation", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const root = await storage.createTree("Root");
      await waitForName(root, "Root");

      await expect(root.createDirectory("")).rejects.toThrow("invalid name");
    } finally {
      stopTestClient(client);
    }
  });

  it("1.9 listTrees returns the caller's top-level trees", async () => {
    const user = await registerTestUser("tree");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const t1 = await storage.createTree("List A");
      const t2 = await storage.createTree("List B");

      // Wait for both trees to appear in listTrees (requires sync to populate
      // currentState with purpose events)
      const trees = await waitFor<MSC3089TreeSpace[]>(
        async () => {
          const ts = await storage.listTrees();
          if (ts.length >= 2) return ts;
          return null;
        },
        { label: "both trees visible", timeoutMs: 15000 },
      );

      const ids = trees.map((t) => t.id);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
    } finally {
      stopTestClient(client);
    }
  });

  it("1.10 fresh client for the same user can find a tree via listTrees", async () => {
    const user = await registerTestUser("tree");
    // Reuse the same device's persisted crypto state across the restart. An
    // in-memory store would make clientB advertise a fresh set of one-time
    // keys under the same Matrix device ID, which the server correctly
    // rejects as a collision.
    const clientA = await createTestClient(user, { useIndexedDB: true });
    let treeId: string;
    try {
      const storageA = new TeleCryptIOStorage(clientA);
      const tree = await storageA.createTree("Persist");
      treeId = tree.id;

      // Wait for it to appear locally
      await waitFor(
        async () => {
          const ts = await storageA.listTrees();
          return ts.some((t) => t.id === treeId) ? ts : null;
        },
        { label: "tree visible in clientA", timeoutMs: 15000 },
      );
    } finally {
      stopTestClient(clientA);
    }

    // Fresh client, same user and device; reconnect using clientA's store.
    const clientB = await createTestClient(user, { useIndexedDB: true });
    try {
      const storageB = new TeleCryptIOStorage(clientB);
      const treesB = await waitFor<MSC3089TreeSpace[]>(
        async () => {
          const trees = await storageB.listTrees();
          return trees.length > 0 ? trees : null;
        },
        { label: "fresh client finds tree", timeoutMs: 15000 },
      );
      expect(treesB.some((t) => t.id === treeId)).toBe(true);
    } finally {
      stopTestClient(clientB);
    }
  });
});
