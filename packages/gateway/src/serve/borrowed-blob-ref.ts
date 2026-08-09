/*
 * Which columns of which BORROWED-STORE entities name a blob, and at what
 * rung — extracted out of `borrowed-store.ts` to keep that file under the
 * repo's file-size guidance (#726 P4).
 *
 * A closed, small vocabulary because that is all `core.content_*` presently
 * declares. `core.content_derivative`'s `variant` IS the rung
 * (thumb/preview/poster); `core.content_item`'s bytes are always the
 * original. Any other entity, or a row whose field mask excluded these
 * columns, names no blob — a correct silence (D10's mask-refuses-quietly
 * posture), not a gap to fill in later.
 */

export interface BorrowedBlobRef {
  sha256: string;
  rung: string;
  byteSize: number;
}

export function blobRefIn(
  entity: string,
  values: Record<string, unknown>
): BorrowedBlobRef | undefined {
  const sha256 = values.sha256;
  if (typeof sha256 !== "string" || sha256.length === 0) return undefined;
  const byteSize = typeof values.byte_size === "number" ? values.byte_size : 0;
  if (entity === "core.content_derivative") {
    const variant = values.variant;
    return typeof variant === "string"
      ? { sha256, rung: variant, byteSize }
      : undefined;
  }
  if (entity === "core.content_item") {
    return { sha256, rung: "original", byteSize };
  }
  return undefined;
}
