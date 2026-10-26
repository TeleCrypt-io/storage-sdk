import type { MatrixClient } from "matrix-js-sdk";

interface DeletionMarkers {
  readonly trees: Set<string>;
}

const markersByClient = new WeakMap<MatrixClient, DeletionMarkers>();

function markersFor(client: MatrixClient): DeletionMarkers {
  let markers = markersByClient.get(client);
  if (!markers) {
    markers = { trees: new Set() };
    markersByClient.set(client, markers);
  }
  return markers;
}

/** Records a confirmed room deletion for this MatrixClient's lifetime. */
export function markTreeDeleted(client: MatrixClient, roomId: string): void {
  markersFor(client).trees.add(roomId);
}

export function isTreeDeleted(client: MatrixClient, roomId: string): boolean {
  return markersFor(client).trees.has(roomId);
}

export function getDeletedTreeIds(client: MatrixClient): ReadonlySet<string> {
  return markersFor(client).trees;
}
