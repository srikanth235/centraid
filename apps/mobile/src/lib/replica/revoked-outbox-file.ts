// WHERE A REVOKED PHONE PUTS THE MEMBER'S UNSENT WORK (#1014, P24).
//
// The module's durable, backup-excluded directory — the same place the seat
// file and the upload queue live — and NOT inside the seat file, because the
// seat file is the thing being unlinked. `revoked-outbox-<vaultId>.json`, one
// per vault so two revocations never overwrite each other.
//
// Written through a scratch file and moved in, for the reason every other
// durable write in this directory is: a process killed mid-write must leave
// the previous export or none, never half a queue that parses into a shorter
// one.

import type { RevokedOutboxSink } from "@centraid/client/replica/native";

import {
  pathToFileUri,
  replicaStorageDirectory,
} from "../../../modules/centraid-storage";

export function nativeRevokedOutboxSink(
  storageLocation = replicaStorageDirectory()
): RevokedOutboxSink | undefined {
  // No durable directory is a host that cannot hold this. It gets no sink
  // rather than one that writes nowhere: the export policy then reports the
  // COUNT with `saved: false`, which is the honest answer to give the member.
  if (!storageLocation) return undefined;
  const location = storageLocation.replace(/\/+$/u, "");
  return {
    // expo-file-system is imported HERE, not at module scope: this module is
    // reached from the mount's revocation path, and a static edge would drag
    // the native module into every suite that renders the provider.
    write: async (fileName: string, body: string): Promise<void> => {
      const { Directory, File } = await import("expo-file-system");
      const dir = new Directory(pathToFileUri(location));
      if (!dir.exists) dir.create({ intermediates: true });
      const target = new File(pathToFileUri(`${location}/${fileName}`));
      const scratch = new File(
        pathToFileUri(`${location}/${fileName}.writing`)
      );
      if (scratch.exists) scratch.delete();
      scratch.create({ intermediates: true });
      scratch.write(body);
      if (target.exists) target.delete();
      scratch.moveSync(target);
    },
  };
}
