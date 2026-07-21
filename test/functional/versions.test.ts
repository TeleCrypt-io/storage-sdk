// 4.6 needs a *persistent* crypto store so that a fresh MatrixClient instance
// (same user/device, but restarted) still has its megolm sessions available —
// otherwise it can never decrypt anything it didn't just receive live, no matter
// how much timeline pagination happens. Node has no native IndexedDB, so we
// polyfill it for this file only (other test files are unaffected: vitest
// isolates each test file's globals, and every other call site keeps passing
// useIndexedDB: false explicitly).
import "fake-indexeddb/auto";
import { describe, it, expect } from "vitest";
import { registerTestUser } from "../harness/users";
import { createTestClient, stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage";

describe("versioning", () => {
  it("4.1 createNewVersion increments version", async () => {
    const user = await registerTestUser("ver");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("VersionTest");
      await waitFor(() => tree.room.name === "VersionTest");

      const data = new TextEncoder().encode("v1 content").buffer as ArrayBuffer;
      const _eventId = await storage.uploadFile(tree, "doc.txt", data, "text/plain");

      // Wait for the file to appear
      const files = await waitFor(
        async () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "file visible", timeoutMs: 15000 },
      );

      expect(files[0].version).toBe(1);

      // Create a new version
      const v2Data = new TextEncoder().encode("v2 content").buffer as ArrayBuffer;
      const encrypted = await (
        await import("matrix-encrypt-attachment")
      ).encryptAttachment(v2Data);
      const { event_id: v2EventId } = await files[0].createNewVersion(
        "doc.txt",
        Buffer.from(encrypted.data),
        encrypted.info,
        { info: { mimetype: "text/plain", size: v2Data.byteLength } },
      );

      // Wait for the new version to appear
      await waitFor(
        () => tree.listFiles().some((f) => f.id === v2EventId),
        { label: "v2 visible in listFiles", timeoutMs: 15000 },
      );

      const updatedFiles = tree.listFiles();
      const v2Branch = updatedFiles.find(
        (f) => f.id === v2EventId,
      )!;
      expect(v2Branch.version).toBe(2);
    } finally {
      stopTestClient(client);
    }
  });

  it("4.2 getVersionHistory returns all versions newest first", async () => {
    const user = await registerTestUser("ver");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("HistTest");
      await waitFor(() => tree.room.name === "HistTest");

      const v1Data = new TextEncoder().encode("v1").buffer as ArrayBuffer;
      const eventId = await storage.uploadFile(tree, "hist.txt", v1Data, "text/plain");

      const files = await waitFor(
        async () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "v1 visible", timeoutMs: 15000 },
      );
      const branch = files.find((f) => f.id === eventId)!;

      // Create v2
      const v2Data = new TextEncoder().encode("v2").buffer as ArrayBuffer;
      const enc2 = await (
        await import("matrix-encrypt-attachment")
      ).encryptAttachment(v2Data);
      const { event_id: v2Id } = await branch.createNewVersion(
        "hist.txt",
        Buffer.from(enc2.data),
        enc2.info,
        { info: { mimetype: "text/plain", size: v2Data.byteLength } },
      );

      await waitFor(
        () => tree.listFiles().some((f) => f.id === v2Id),
        { label: "v2 visible", timeoutMs: 15000 },
      );

      const v2Branch = tree.listFiles().find((f) => f.id === v2Id)!;
      const history = await v2Branch.getVersionHistory();
      expect(history.length).toBe(2);
      // The first in the list should be the latest version
      expect(history[0].version).toBeGreaterThanOrEqual(history[history.length - 1]?.version ?? 0);
    } finally {
      stopTestClient(client);
    }
  });

  it("4.3 old version content is still downloadable and decryptable", async () => {
    const user = await registerTestUser("ver");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("OldVer");
      await waitFor(() => tree.room.name === "OldVer");

      const v1Data = new TextEncoder().encode("version one content").buffer as ArrayBuffer;
      const eventId = await storage.uploadFile(tree, "ver.txt", v1Data, "text/plain");
      const files = await waitFor(
        async () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "v1 visible", timeoutMs: 15000 },
      );
      const branch = files.find((f) => f.id === eventId)!;

      // Create v2
      const v2Data = new TextEncoder().encode("version two content").buffer as ArrayBuffer;
      const enc2 = await (
        await import("matrix-encrypt-attachment")
      ).encryptAttachment(v2Data);
      const { event_id: v2Id } = await branch.createNewVersion(
        "ver.txt",
        Buffer.from(enc2.data),
        enc2.info,
        { info: { mimetype: "text/plain", size: v2Data.byteLength } },
      );

      await waitFor(
        () => tree.listFiles().some((f) => f.id === v2Id),
        { label: "v2 visible", timeoutMs: 15000 },
      );

      // Get version history and download v1
      const v2Branch = tree.listFiles().find((f) => f.id === v2Id)!;
      const history = await v2Branch.getVersionHistory();

      const oldVersion = history.find((v) => v.version === 1) ?? history[history.length - 1];
      const downloaded = await storage.downloadFile(oldVersion);
      const decoded = new TextDecoder().decode(downloaded.data);
      expect(decoded).toBe("version one content");
    } finally {
      stopTestClient(client);
    }
  });

  it("4.4 listFiles shows only current; listAllFiles shows all", async () => {
    const user = await registerTestUser("ver");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("ListAll");
      await waitFor(() => tree.room.name === "ListAll");

      const v1Data = new TextEncoder().encode("v1").buffer as ArrayBuffer;
      const eventId = await storage.uploadFile(tree, "all.txt", v1Data, "text/plain");
      const files = await waitFor(
        async () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "v1 visible", timeoutMs: 15000 },
      );
      const branch = files.find((f) => f.id === eventId)!;

      // Create v2
      const v2Data = new TextEncoder().encode("v2").buffer as ArrayBuffer;
      const enc2 = await (
        await import("matrix-encrypt-attachment")
      ).encryptAttachment(v2Data);
      const { event_id: v2Id } = await branch.createNewVersion(
        "all.txt",
        Buffer.from(enc2.data),
        enc2.info,
        { info: { mimetype: "text/plain", size: v2Data.byteLength } },
      );

      await waitFor(
        () => tree.listFiles().some((f) => f.id === v2Id),
        { label: "v2 visible", timeoutMs: 15000 },
      );

      // listFiles should return only active (latest) files — wait for old version to go inactive
      const activeFiles = await waitFor(
        () => {
          const fs = tree.listFiles();
          return fs.length === 1 && fs[0].id === v2Id ? fs : null;
        },
        { label: "only active files remain", timeoutMs: 10000 },
      );
      expect(activeFiles[0].isActive).toBe(true);

      // listAllFiles should return all versions
      const allFiles = tree.listAllFiles();
      expect(allFiles.length).toBeGreaterThanOrEqual(2);
    } finally {
      stopTestClient(client);
    }
  });

  it("4.5 renaming a file does not create a new version", async () => {
    const user = await registerTestUser("ver");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("RenameVer");
      await waitFor(() => tree.room.name === "RenameVer");

      const data = new TextEncoder().encode("rename test").buffer as ArrayBuffer;
      await storage.uploadFile(tree, "oldname.txt", data, "text/plain");
      const files = await waitFor(
        async () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "file visible", timeoutMs: 15000 },
      );
      const branch = files[0];
      const origVersion = branch.version;

      await branch.setName("newname.txt");

      // Re-fetch the branch to get updated indexEvent after sync
      await waitFor(
        () => {
          const refreshed = tree.getFile(branch.id);
          return refreshed?.getName() === "newname.txt" ? refreshed : null;
        },
        { label: "name changed", timeoutMs: 10000 },
      );
      const refreshed = tree.getFile(branch.id)!;
      expect(refreshed.getName()).toBe("newname.txt");

      expect(refreshed.version).toBe(origVersion);
    } finally {
      stopTestClient(client);
    }
  });

  it("4.6 fresh client recovers full version chain", async () => {
    const user = await registerTestUser("ver");
    // Persistent crypto store: a real client persists megolm sessions across
    // restarts. Without this, clientB below would be crypto-amnesiac (same
    // device, empty store) and could never decrypt anything.
    const clientA = await createTestClient(user, { useIndexedDB: true });
    let treeId: string;
    try {
      const storageA = new TeleCryptIOStorage(clientA);
      const tree = await storageA.createTree("FreshHist");
      await waitFor(() => tree.room.name === "FreshHist");
      treeId = tree.id;

      // Create 3 versions
      const v1Data = new TextEncoder().encode("v1 data").buffer as ArrayBuffer;
      const eventId = await storageA.uploadFile(tree, "fresh.txt", v1Data, "text/plain");
      const files = await waitFor(
        async () => {
          const fs = tree.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "v1 visible", timeoutMs: 15000 },
      );
      const branch = files.find((f) => f.id === eventId)!;

      const enc2 = await (await import("matrix-encrypt-attachment")).encryptAttachment(
        new TextEncoder().encode("v2 data").buffer as ArrayBuffer,
      );
      const { event_id: v2Id } = await branch.createNewVersion(
        "fresh.txt",
        Buffer.from(enc2.data),
        enc2.info,
        { info: { mimetype: "text/plain", size: 7 } },
      );

      await waitFor(
        () => tree.listFiles().some((f) => f.id === v2Id),
        { label: "v2 visible", timeoutMs: 15000 },
      );

      const v2Branch = tree.listFiles().find((f) => f.id === v2Id)!;
      const enc3 = await (await import("matrix-encrypt-attachment")).encryptAttachment(
        new TextEncoder().encode("v3 data").buffer as ArrayBuffer,
      );
      const { event_id: v3Id } = await v2Branch.createNewVersion(
        "fresh.txt",
        Buffer.from(enc3.data),
        enc3.info,
        { info: { mimetype: "text/plain", size: 7 } },
      );

      await waitFor(
        () => tree.listFiles().some((f) => f.id === v3Id),
        { label: "v3 visible", timeoutMs: 15000 },
      );
    } finally {
      stopTestClient(clientA);
    }

    // Fresh client, same user — reconnects using the same persistent crypto store
    // clientA wrote to, so it should inherit the megolm sessions it needs.
    const clientB = await createTestClient(user, { useIndexedDB: true });
    try {
      const storageB = new TeleCryptIOStorage(clientB);
      const trees = await waitFor(
        async () => {
          const ts = await storageB.listTrees();
          return ts.length > 0 ? ts : null;
        },
        { label: "fresh client lists trees", timeoutMs: 15000 },
      );
      const treeB = trees.find((t) => t.id === treeId)!;

      // Wait for at least one file to appear
      await waitFor(
        () => {
          const fs = treeB.listFiles();
          return fs.length > 0 ? fs : null;
        },
        { label: "fresh client sees files", timeoutMs: 15000 },
      );

      // getVersionHistory()'s backward walk depends on v2's and v3's messages being
      // locally decrypted (so their m.relates_to can be aggregated) — on a fresh
      // client that decryption is asynchronous and can still be settling even after
      // the (unencrypted) branch state events have already landed. Poll for the full
      // chain rather than asserting on the first read, re-fetching the branch each
      // time: this waits out legitimate decryption-settling latency without masking
      // genuine key-denial — if the chain can never reach 3, this times out and
      // fails deterministically, which is the correct outcome.
      const history = await waitFor(
        async () => {
          const files = treeB.listFiles();
          if (files.length === 0) return null;
          const h = await files[0].getVersionHistory();
          return h.length === 3 ? h : null;
        },
        { label: "full version chain recovered", timeoutMs: 15000 },
      );

      // A fresh client (independent sync from scratch) must recover the FULL
      // chain of 3 versions, newest first.
      expect(history.length).toBe(3);
      expect(history.map((v) => v.version)).toEqual([3, 2, 1]);
    } finally {
      stopTestClient(clientB);
    }
  });
});
