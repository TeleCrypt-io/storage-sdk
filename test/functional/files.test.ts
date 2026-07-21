import { describe, it, expect } from "vitest";
import { registerTestUser } from "../harness/users";
import { createTestClient, stopTestClient } from "../harness/clients";
import { waitFor } from "../harness/waitFor";
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

describe("encrypted files", () => {
  it("2.1 upload and download a small text file, byte-identical", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("Files");
      await waitFor(() => tree.room.name === "Files", {
        label: "tree name visible",
      });

      const plaintext = new TextEncoder().encode("Hello, encrypted world!")
        .buffer as ArrayBuffer;
      await storage.uploadFile(tree, "hello.txt", plaintext, "text/plain");

      const files = await waitForFiles(tree);
      expect(files.length).toBe(1);
      expect(files[0].getName()).toBe("hello.txt");

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
      await waitFor(() => tree.room.name === "Binaries", {
        label: "tree name visible",
      });

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
      await waitFor(() => tree.room.name === "ListTest", {
        label: "tree name visible",
      });

      const data = new TextEncoder().encode("naming").buffer as ArrayBuffer;
      await storage.uploadFile(tree, "mydoc.txt", data, "text/plain");

      const files = await waitForFiles(tree);
      expect(files.some((f) => f.getName() === "mydoc.txt")).toBe(true);
    } finally {
      stopTestClient(client);
    }
  });

  it("2.4 branch.getName() returns the original filename", async () => {
    const user = await registerTestUser("file");
    const client = await createTestClient(user);
    try {
      const storage = new TeleCryptIOStorage(client);
      const tree = await storage.createTree("NameTest");
      await waitFor(() => tree.room.name === "NameTest", {
        label: "tree name visible",
      });

      const data = new TextEncoder().encode("namecheck").buffer as ArrayBuffer;
      await storage.uploadFile(tree, "report.pdf", data, "application/pdf");

      const files = await waitForFiles(tree);
      const branch = files.find((f) => f.getName() === "report.pdf");
      expect(branch).toBeDefined();
      expect(branch!.getName()).toBe("report.pdf");
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
      await waitFor(() => tree.room.name === "Unicode", {
        label: "tree name visible",
      });

      const data = new TextEncoder().encode("unicode content").buffer as ArrayBuffer;
      const name = "тест-файл.txt";
      await storage.uploadFile(tree, name, data, "text/plain");

      const files = await waitForFiles(tree);
      expect(files.some((f) => f.getName() === name)).toBe(true);
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
      await waitFor(() => tree.room.name === "MimeTest", {
        label: "tree name visible",
      });

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
      await waitFor(() => tree.room.name === "CryptoTest", {
        label: "tree name visible",
      });

      const plaintext = new TextEncoder().encode(
        "SECRET: this must not be stored in plaintext on the server",
      ).buffer as ArrayBuffer;

      const eventId = await storage.uploadFile(
        tree,
        "secret.txt",
        plaintext,
        "text/plain",
      );

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
      await waitFor(() => tree.room.name === "DelTest", {
        label: "tree name visible",
      });

      const data = new TextEncoder().encode("delete me").buffer as ArrayBuffer;
      const eventId = await storage.uploadFile(tree, "gone.txt", data, "text/plain");

      const before = await waitForFiles(tree);
      expect(before.some((f) => f.id === eventId)).toBe(true);

      const branch = before.find((f) => f.id === eventId)!;
      await branch.delete();

      await waitFor(
        () => !tree.listFiles().some((f) => f.id === eventId),
        { label: "file removed from listFiles", timeoutMs: 10000 },
      );

      const after = tree.listFiles();
      expect(after.some((f) => f.id === eventId)).toBe(false);
    } finally {
      stopTestClient(client);
    }
  });
});
