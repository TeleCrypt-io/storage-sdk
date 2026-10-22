import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { MatrixError, UNSTABLE_MSC3089_BRANCH } from "matrix-js-sdk";
import { TeleCryptIOStorage } from "../../src/TeleCryptIOStorage.js";
import { MutationPartialError } from "../../src/core/errors.js";
import { registerTestUser } from "../harness/users.js";
import { createTestClient, stopTestClient } from "../harness/clients.js";

describe("partial upload cleanup against Synapse", () => {
  it("removes accepted media and the attachment after a definitive listing rejection", async () => {
    const user = await registerTestUser("upload_reject");
    const client = await createTestClient(user);
    const storage = new TeleCryptIOStorage(client);
    try {
      const tree = await storage.createTree("Rejected upload");
      const upload = vi.spyOn(client, "uploadContent");
      const message = vi.spyOn(client, "sendMessage");
      const original = client.sendStateEvent.bind(client);
      vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
        if (args[1] === UNSTABLE_MSC3089_BRANCH.name) {
          throw new MatrixError({ errcode: "M_FORBIDDEN", error: "listing rejected" }, 403);
        }
        return original(...args);
      });
      await expect(storage.uploadFile(tree, "rejected.txt", new TextEncoder().encode("bytes").buffer, "text/plain"))
        .rejects.toThrow("file upload was rejected; uploaded media and attachment were removed");
      const uploaded = await upload.mock.results[0]!.value;
      const sent = await message.mock.results[0]!.value;
      await storage.refreshRoomState(tree.id);
      expect(tree.listFiles()).toHaveLength(0);
      expect((await storage.getOriginalFileEvent(tree.id, sent.event_id, true)).isRedacted()).toBe(true);
      const url = client.mxcUrlToHttp(uploaded.content_uri, undefined, undefined, undefined, false, true, true)!;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${client.getAccessToken()}` } });
      expect(response.status).toBe(404);
      await response.text();
    } finally {
      vi.restoreAllMocks();
      stopTestClient(client);
    }
  }, 60_000);

  it("preserves a committed file after a lost response, then explicitly cleans it up with retained IDs", async () => {
    const user = await registerTestUser("upload_unknown");
    const client = await createTestClient(user);
    const storage = new TeleCryptIOStorage(client);
    try {
      const tree = await storage.createTree("Unknown upload");
      const original = client.sendStateEvent.bind(client);
      vi.spyOn(client, "sendStateEvent").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[1] === UNSTABLE_MSC3089_BRANCH.name) throw new Error("listing response lost");
        return result;
      });
      const error = await storage.uploadFile(tree, "accepted.txt", new TextEncoder().encode("retained bytes").buffer, "text/plain")
        .then(() => { throw new Error("expected partial result"); }, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(MutationPartialError);
      const partial = error as MutationPartialError;
      expect(partial.treeId).toBe(tree.id);
      expect(partial.completedIds).toHaveLength(2);
      const [mediaId, fileId] = partial.completedIds;
      await storage.refreshRoomState(tree.id);
      const branch = tree.getFile(fileId!)!;
      expect(new TextDecoder().decode((await storage.downloadFile(branch)).data)).toBe("retained bytes");
      await storage.cleanupFileUpload(tree.id, mediaId!, fileId);
      await storage.cleanupFileUpload(tree.id, mediaId!, fileId);
      await storage.refreshRoomState(tree.id);
      expect(tree.listFiles()).toHaveLength(0);
      expect((await storage.getOriginalFileEvent(tree.id, fileId!, true)).isRedacted()).toBe(true);
      const url = client.mxcUrlToHttp(mediaId!, undefined, undefined, undefined, false, true, true)!;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${client.getAccessToken()}` } });
      expect(response.status).toBe(404);
      await response.text();
    } finally {
      vi.restoreAllMocks();
      stopTestClient(client);
    }
  }, 60_000);
});
