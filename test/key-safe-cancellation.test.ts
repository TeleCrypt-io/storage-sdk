import { createServer } from "node:http";
import { createClient } from "matrix-js-sdk";
import { expect, it } from "vitest";
import { TeleCryptIOStorage } from "../src/TeleCryptIOStorage.js";

it("cancels stalled Safe reads and queued work, then permits a retry", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let stalled = true;
  let requests = 0;
  const server = createServer(async (_request, response) => {
    requests++;
    if (stalled) await gate;
    if (!response.destroyed) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ errcode: "M_NOT_FOUND" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP server did not start");
  const client = createClient({ baseUrl: `http://127.0.0.1:${address.port}`, userId: "@test:example.test", deviceId: "DEVICE", accessToken: "fixture-token" });
  const storage = new TeleCryptIOStorage(client, { persistentCryptoStore: false });
  try {
    const first = new AbortController();
    const second = new AbortController();
    const active = storage.keySafe.getStatus(first.signal);
    await viWaitForRequests();
    const queued = storage.keySafe.getStatus(second.signal);
    second.abort();
    await expect(queued).rejects.toThrow("operation cancelled");
    first.abort();
    await expect(active).rejects.toThrow("operation cancelled");
    stalled = false;
    release();
    await expect(storage.keySafe.getStatus()).resolves.toMatchObject({ state: "setup-required" });
  } finally {
    release();
    client.stopClient();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async function viWaitForRequests() {
    const deadline = Date.now() + 5000;
    while (requests < 2) {
      if (Date.now() > deadline) throw new Error("Safe reads did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
});
