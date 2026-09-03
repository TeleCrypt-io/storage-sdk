import type { MatrixClient } from "matrix-js-sdk";

interface DeletionMarkers {
  readonly trees: Set<string>;
  readonly files: Map<string, Set<string>>;
}

const markersByClient = new WeakMap<MatrixClient, DeletionMarkers>();

function markersFor(client: MatrixClient): DeletionMarkers {
  let markers = markersByClient.get(client);
  if (!markers) {
    markers = { trees: new Set(), files: new Map() };
    markersByClient.set(client, markers);
  }
  return markers;
}

/** Records a confirmed room deletion for this MatrixClient's lifetime. */
export function markTreeDeleted(client: MatrixClient, roomId: string): void {
  markersFor(client).trees.add(roomId);
}

/** Records a confirmed file deletion for this MatrixClient's lifetime. */
export function markFileDeleted(client: MatrixClient, roomId: string, fileId: string): void {
  const markers = markersFor(client);
  let files = markers.files.get(roomId);
  if (!files) {
    files = new Set();
    markers.files.set(roomId, files);
  }
  files.add(fileId);
}

export function isTreeDeleted(client: MatrixClient, roomId: string): boolean {
  return markersFor(client).trees.has(roomId);
}

export function getDeletedTreeIds(client: MatrixClient): ReadonlySet<string> {
  return markersFor(client).trees;
}

export function isFileDeleted(client: MatrixClient, roomId: string, fileId: string): boolean {
  return markersFor(client).files.get(roomId)?.has(fileId) ?? false;
}
