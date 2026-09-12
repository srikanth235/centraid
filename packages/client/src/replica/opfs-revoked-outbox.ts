// WHERE A REVOKED BROWSER SEAT PUTS THE MEMBER'S UNSENT WORK (#1014, P24).
//
// OPFS root, NOT the seat's SAH pool and not the staging directory. The pool
// is being unlinked and staging is thrown away by design; this file has to
// outlive both, and the origin's own root is the one place in a browser that
// survives a purge of everything the replica owns.
//
// It is deliberately a plain JSON file with a name a person can be told:
// `revoked-outbox-<vaultId>.json`. Recovering from it is a support step, not a
// product surface — but "the member's edits are in this file" is a sentence
// that can be said, and "they were deleted" is not.

import type { RevokedOutboxSink } from "./revoked-outbox.js";

/** The slice of OPFS this uses, so a suite can stand it up. */
export interface RevokedOutboxDirectory {
  getFileHandle: (
    name: string,
    options?: { create?: boolean }
  ) => Promise<{
    createWritable: () => Promise<{
      write: (data: {
        type: "write";
        position: number;
        data: Uint8Array;
      }) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

export function opfsRevokedOutboxSink(
  directory?: () => Promise<RevokedOutboxDirectory>
): RevokedOutboxSink | undefined {
  const resolve =
    directory ??
    (globalThis.navigator?.storage?.getDirectory
      ? () =>
          globalThis.navigator.storage.getDirectory() as unknown as Promise<RevokedOutboxDirectory>
      : undefined);
  // A browser with no OPFS is a host that cannot durably hold this. It gets no
  // sink rather than a sink that silently writes nowhere — the export policy
  // then reports the COUNT with `saved: false`, which is the honest answer.
  if (!resolve) return undefined;
  return {
    write: async (fileName: string, body: string): Promise<void> => {
      const handle = await (
        await resolve()
      ).getFileHandle(fileName, {
        create: true,
      });
      const writer = await handle.createWritable();
      await writer.write({
        type: "write",
        position: 0,
        data: new TextEncoder().encode(body),
      });
      await writer.close();
    },
  };
}
