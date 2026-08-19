/*
 * Derivatives cross WITH the closure (#726 P3 decision 7): a derivative rung
 * must be projectable at the give, not fetched later by the same background
 * pull that carries originals, or the audience paints nothing until the
 * original arrives — the whole point of giving thumbnails eagerly. This is
 * the ORIGIN-side half: read each non-original blob manifest entry's bytes
 * out of the origin's own CAS and base64 them for the JSON give frame.
 *
 * Only the ORIGIN side survives here. The audience-side halves — shape
 * checks, hash verification, and CAS adoption of carried bytes — left with
 * the give frames they served (#825, ruling G-copy); a grant's audience is
 * written by the fulfillment engine's own projection instead.
 */

import type { ShareVaultRef, WireClosure } from "@centraid/vault";

export interface WireDerivativeBlob {
  sha256: string;
  rung: string;
  bytes: string;
}

/**
 * Throws if the origin's own CAS is missing bytes for a derivative its own
 * closure just named — a local integrity gap, not a peer-facing refusal, so
 * the caller's ordinary catch-and-park handles it the same as any other
 * local read failure.
 */
export function collectDerivativeBlobs(
  origin: ShareVaultRef,
  closure: WireClosure
): WireDerivativeBlob[] {
  const out: WireDerivativeBlob[] = [];
  for (const entry of closure.blobs) {
    if (entry.rung === "original") continue;
    const bytes = origin.blobs.local.getSync(entry.sha256);
    if (bytes === null) {
      throw new Error(
        `origin vault is missing local bytes for derivative ${entry.sha256}`
      );
    }
    out.push({
      sha256: entry.sha256,
      rung: entry.rung,
      bytes: bytes.toString("base64"),
    });
  }
  return out;
}
