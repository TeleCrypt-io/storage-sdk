import type { MatrixClient } from "matrix-js-sdk";
import { StorageError } from "./core/errors.js";

/** Use the same account/device requirements for explicit and inherited sharing. */
export async function prepareReaderHistorySharing(
  client: MatrixClient,
  userId: string,
): Promise<() => Promise<void>> {
  const crypto = client.getCrypto();
  if (!crypto) throw new StorageError("sharing requires initialized encryption");
  const recipient = await client.downloadKeysForUsers([userId]);
  const devices = Object.keys(recipient.device_keys?.[userId] ?? {});
  if (!recipient.master_keys?.[userId] || !recipient.self_signing_keys?.[userId] || devices.length === 0) {
    throw new StorageError("The reader must set up or unlock their Decryption Key Safe before sharing");
  }
  return async () => {
    const statuses = await Promise.all(devices.map((id) => crypto.getDeviceVerificationStatus(userId, id)));
    if (!statuses.some((status) => status?.signedByOwner)) {
      throw new StorageError("The invitation was sent, but history keys could not be shared; the reader must unlock their Decryption Key Safe, then retry sharing");
    }
  };
}
