import { describe, it, expect } from "vitest";
import { registerTestUser } from "../harness/users";
import { createTestClient, stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
import { EventType, UNSTABLE_MSC3089_BRANCH } from "matrix-js-sdk";
import { TeleCryptIOStorage, MSC3089Branch } from "../../src/TeleCryptIOStorage";

function randomBuffer(size: number): ArrayBuffer {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return buf.buffer as ArrayBuffer;
}

async function waitForFiles(
  tree: { listFiles: () => MSC3089Branch[] },
  minCount = 1,
): Promise<MSC3089Branch[]> {
  return waitFor<MSC3089Branch[]>(
    () => {
      const files = tree.listFiles();
      return files.length >= minCount ? files : null;
    },
    { label: `at least ${minCount} file(s)`, timeoutMs: 15000 },
  );
}

async function waitForTreeName(storage: TeleCryptIOStorage, treeId: string, expected: string): Promise<void> {
  await waitFor(async () => {
    try {
      return (await storage.getTreeName(treeId)) === expected;
    } catch {
      return false;
    }
  }, { label: "encrypted tree name visible", timeoutMs: 15000 });
}

describe("encrypted files", () => {
  it("2.1 upload and download a small text file, byte-identical", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("Files");
      await waitForTreeName(storage, tree.id, "Files");

      const plaintext = new TextEncoder().encode("Hello, encrypted world!")
        .buffer as ArrayBuffer;
      await storage.uploadFile(tree, "hello.txt", plaintext, "text/plain");

      const files = await waitForFiles(tree);
      expect(files.length).toBe(1);
      expect(await storage.getFileName(tree.id, files[0]!.id)).toBe("hello.txt");

      const downloaded = await storage.downloadFile(files[0]);
      const decoded = new TextDecoder().decode(downloaded.data);
      expect(decoded).toBe("Hello, encrypted world!");
      expect(downloaded.mimetype).toBe("text/plain");
    } finally {
      stopTestClient(client);
    }
  });

  it("2.2 upload binary file (100 KB), round-trips byte-identically", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("Binaries");
      await waitForTreeName(storage, tree.id, "Binaries");

      const original = randomBuffer(100 * 1024);
      await storage.uploadFile(tree, "data.bin", original, "application/octet-stream");

      const files = await waitForFiles(tree);
      const downloaded = await storage.downloadFile(files[0]);
      expect(new Uint8Array(downloaded.data)).toEqual(new Uint8Array(original));
    } finally {
      stopTestClient(client);
    }
  });

  it("2.3 uploaded file appears in listFiles with correct name", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("ListTest");
      await waitForTreeName(storage, tree.id, "ListTest");

      const data = new TextEncoder().encode("naming").buffer as ArrayBuffer;
      await storage.uploadFile(tree, "mydoc.txt", data, "text/plain");

      const files = await waitForFiles(tree);
      expect(await Promise.all(files.map((file) => storage.getFileName(tree.id, file.id)))).toContain("mydoc.txt");
    } finally {
      stopTestClient(client);
    }
  });

  it("2.4 async metadata lookup returns the encrypted filename", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("NameTest");
      await waitForTreeName(storage, tree.id, "NameTest");

      const data = new TextEncoder().encode("namecheck").buffer as ArrayBuffer;
      await storage.uploadFile(tree, "report.pdf", data, "application/pdf");

      const files = await waitForFiles(tree);
      const branch = files[0]!;
      expect(await storage.getFileName(tree.id, branch.id)).toBe("report.pdf");
    } finally {
      stopTestClient(client);
    }
  });

  it("2.5 non-ASCII filename round-trips correctly", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("Unicode");
      await waitForTreeName(storage, tree.id, "Unicode");

      const data = new TextEncoder().encode("unicode content").buffer as ArrayBuffer;
      const name = "тест-файл.txt";
      await storage.uploadFile(tree, name, data, "text/plain");

      const files = await waitForFiles(tree);
      expect(await Promise.all(files.map((file) => storage.getFileName(tree.id, file.id)))).toContain(name);
    } finally {
      stopTestClient(client);
    }
  });

  it("2.6 mimetype survives the round trip", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("MimeTest");
      await waitForTreeName(storage, tree.id, "MimeTest");

      const data = new TextEncoder().encode("mime check").buffer as ArrayBuffer;
      await storage.uploadFile(tree, "doc.json", data, "application/json");

      const files = await waitForFiles(tree);
      const downloaded = await storage.downloadFile(files[0]);
      expect(downloaded.mimetype).toBe("application/json");
    } finally {
      stopTestClient(client);
    }
  });

  it("2.7 server never sees plaintext", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("CryptoTest");
      await waitForTreeName(storage, tree.id, "CryptoTest");

      const plaintext = new TextEncoder().encode(
        "SECRET: this must not be stored in plaintext on the server",
      ).buffer as ArrayBuffer;

      const eventId = await storage.uploadFile(
        tree,
        "secret.txt",
        plaintext,
        "text/plain",
      );

      expect(await storage.getFileName(tree.id, eventId)).toBe("secret.txt");
      expect(tree.room.name).toBe("Encrypted storage");

      const listing = tree.room.currentState.getStateEvents(UNSTABLE_MSC3089_BRANCH.name, eventId);
      expect(listing?.getContent()).toEqual({ active: true, metadata_event_id: eventId });
      expect(JSON.stringify(listing?.getContent())).not.toContain("secret.txt");

      const fileWireEvent = await client.fetchRoomEvent(tree.id, eventId);
      expect(fileWireEvent.type).toBe(EventType.RoomMessageEncrypted);
      expect(JSON.stringify(fileWireEvent)).not.toContain("secret.txt");
      expect(JSON.stringify(fileWireEvent)).not.toContain("SECRET:");

      const namePointer = tree.room.currentState.getStateEvents("io.telecrypt.storage.metadata", "");
      const treeNameEventId = namePointer?.getContent().event_id;
      expect(treeNameEventId).toEqual(expect.any(String));
      const nameWireEvent = await client.fetchRoomEvent(tree.id, treeNameEventId as string);
      expect(nameWireEvent.type).toBe(EventType.RoomMessageEncrypted);
      expect(JSON.stringify(nameWireEvent)).not.toContain("CryptoTest");

      // Wait for the file to appear in listFiles
      const files = await waitForFiles(tree);
      const branch = files.find((f) => f.id === eventId) ?? files[0];

      // Fetch raw media bytes via authenticated endpoint
      const { info } = await branch.getFileInfo();
      const mxcUrl = info.url;
      const rawUrl = client.mxcUrlToHttp(
        mxcUrl,
        undefined,
        undefined,
        undefined,
        false,
        true,
        true,
      );
      expect(rawUrl).toBeTruthy();

      const rawRes = await fetch(rawUrl!, {
        headers: {
          Authorization: `Bearer ${client.getAccessToken()}`,
        },
      });
      expect(rawRes.ok).toBe(true);
      const rawBytes = new Uint8Array(await rawRes.arrayBuffer());

      // Raw bytes must NOT equal plaintext
      const originalBytes = new Uint8Array(plaintext);
      const notEqual =
        rawBytes.byteLength !== originalBytes.byteLength ||
        !rawBytes.every((b, i) => b === originalBytes[i]);
      expect(notEqual).toBe(true);

      // Verify we CAN still decrypt
      const downloaded = await storage.downloadFile(branch);
      const decoded = new TextDecoder().decode(downloaded.data);
      expect(decoded).toContain("SECRET");
    } finally {
      stopTestClient(client);
    }
  });

  it("2.8 delete a file removes it from listFiles", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("DelTest");
      await waitForTreeName(storage, tree.id, "DelTest");

      const data = new TextEncoder().encode("delete me").buffer as ArrayBuffer;
      const eventId = await storage.uploadFile(tree, "gone.txt", data, "text/plain");

      const before = await waitForFiles(tree);
      expect(before.some((f) => f.id === eventId)).toBe(true);

      const branch = before.find((f) => f.id === eventId)!;
      await branch.setName("renamed-gone.txt");
      await waitFor(async () => {
        try {
          return (await storage.getFileName(tree.id, eventId)) === "renamed-gone.txt";
        } catch {
          return false;
        }
      }, { label: "encrypted rename visible", timeoutMs: 10000 });
      const renameId = tree.room.currentState
        .getStateEvents(UNSTABLE_MSC3089_BRANCH.name, eventId)
        ?.getContent().metadata_event_id as string;
      expect(renameId).not.toBe(eventId);
      await branch.delete();

      await waitFor(
        () => !tree.listFiles().some((f) => f.id === eventId),
        { label: "file removed from listFiles", timeoutMs: 10000 },
      );

      const after = tree.listFiles();
      expect(after.some((f) => f.id === eventId)).toBe(false);
      expect(tree.room.currentState
        .getStateEvents(UNSTABLE_MSC3089_BRANCH.name, eventId)
        ?.getContent()).toEqual({});
      const redactedRename = await client.fetchRoomEvent(tree.id, renameId);
      const redactedAttachment = await client.fetchRoomEvent(tree.id, eventId);
      expect(JSON.stringify(redactedRename)).not.toContain("renamed-gone.txt");
      expect(JSON.stringify(redactedAttachment)).not.toContain("gone.txt");
    } finally {
      stopTestClient(client);
    }
  });
});
