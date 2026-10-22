import type { MatrixClient } from "matrix-js-sdk";
import { Method } from "matrix-js-sdk/lib/http-api/method.js";
import { ClientPrefix } from "matrix-js-sdk/lib/http-api/prefix.js";
import { StorageError } from "./core/errors.js";

/** The policy endpoint authorizes deletion against the uploading user. */
export async function deleteOwnedMedia(
  client: MatrixClient,
  mediaIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  if (!client.http || typeof client.http.authedRequest !== "function") {
    throw new StorageError("Matrix HTTP transport unavailable");
  }
  await client.http.authedRequest(
    Method.Post,
    "/io.telecrypt.storage/delete_media",
    undefined,
    { media_ids: [...mediaIds] },
    { prefix: ClientPrefix.Unstable, rawResponseBody: true, abortSignal: signal },
  );
}
