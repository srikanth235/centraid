/*
 * THE LOOPBACK ROUTE (#929). When the audience vault is mounted on this same
 * host, the frame never leaves the process: the manifest's bytes are hardlinked
 * (one inode, zero copies — the property share-by-placement was built on) and
 * the frame is ingested through the same seat function the peer route calls.
 *
 * That sameness is the point. A co-hosted share and a cross-gateway share take
 * one delivery path and differ only in the transport, so a bug that reaches one
 * reaches the other and a test on the golden pair covers both.
 */

import type {
  ShareDeliveryOutcome,
  ShareRemovalOutcome,
  ShareShapeTransport,
} from "../grant/fulfillment.js";
import { placeBlob } from "./blobs.js";
import type { ShareVaultRef } from "./placement.js";
import { ingestShareShape, purgeShareShape } from "./subscription-seat.js";

export interface LoopbackShareTransportInput {
  /** `undefined` is a fact about this HOST, never about the grant. */
  seatFor: (vaultId: string) => ShareVaultRef | undefined;
  origin: ShareVaultRef;
  now: () => string;
}

/**
 * A `transportFor` over the vaults this host mounts. `undefined` for a vault it
 * does not — the caller then reaches for the peer route rather than reporting
 * the grant undeliverable, which is what makes reach a fact about the HOST.
 */
export function loopbackShareTransports(
  input: LoopbackShareTransportInput
): (audienceVaultId: string) => ShareShapeTransport | undefined {
  return (audienceVaultId) => loopbackShareTransport(input, audienceVaultId);
}

export function loopbackShareTransport(
  input: LoopbackShareTransportInput,
  audienceVaultId: string
): ShareShapeTransport | undefined {
  const seat = input.seatFor(audienceVaultId);
  if (!seat) return undefined;
  return {
    route: "loopback",
    deliver: (frame): ShareDeliveryOutcome => {
      // Bytes first: a hardlink is idempotent and the origin is never written,
      // so no two-database transaction exists.
      for (const blob of frame.closure.blobs)
        placeBlob(input.origin.blobs.local, seat.blobs.local, blob.sha256);
      const result = ingestShareShape(seat.vault, frame, {
        audienceVaultId,
        now: input.now(),
      });
      return {
        outcome: "delivered",
        apply: result.apply,
        fieldUpdates: result.fieldUpdates,
      };
    },
    remove: (removal): ShareRemovalOutcome => {
      const result = purgeShareShape(seat.vault, {
        shapeId: removal.shapeId,
        audienceVaultId: removal.audienceVaultId,
        now: input.now(),
      });
      return {
        outcome: "acknowledged",
        removed: result.removed,
        retained: result.retained,
      };
    },
  };
}
