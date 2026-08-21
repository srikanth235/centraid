// Same-machine byte placement for the commons suites (issue #750).
//
// Production never takes this path: a seat that is not on the steward's
// filesystem pulls the snapshot's and the increment's bytes over the peer
// plane (`packages/server/src/serve/peer-commons-client.ts`). These helpers
// exist so a test can put two real vaults on one disk and move exactly the
// bytes a wire frame names — which is why they are filed as fixtures rather
// than as a vault capability with no production caller.

import { placeBlob } from "./blobs.js";
import type {
  CommonsBootstrap,
  CommonsIncrement,
} from "./commons-bootstrap.js";
import type { ShareVaultRef } from "./placement.js";

/** Place the snapshot's bytes by sha. */
export function placeCommonsBootstrapBlobs(input: {
  source: ShareVaultRef;
  seat: ShareVaultRef;
  wire: CommonsBootstrap;
}): void {
  for (const blob of input.wire.closure.blobs)
    placeBlob(input.source.blobs.local, input.seat.blobs.local, blob.sha256);
}

/** The increment lane: only the bytes the replayed tail claims by sha move. */
export function placeCommonsIncrementBlobs(input: {
  source: ShareVaultRef;
  seat: ShareVaultRef;
  increment: CommonsIncrement;
}): void {
  for (const blob of input.increment.blobs)
    placeBlob(input.source.blobs.local, input.seat.blobs.local, blob.sha256);
}
