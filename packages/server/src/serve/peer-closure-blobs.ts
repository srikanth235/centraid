/*
 * Derivatives cross WITH the closure (#726 P3 decision 7): a derivative rung
 * must be projectable at the give, not fetched later by the same background
 * pull that carries originals, or the audience paints nothing until the
 * original arrives — the whole point of giving thumbnails eagerly. This is
 * the ORIGIN-side half: read each non-original blob manifest entry's bytes
 * out of the origin's own CAS and base64 them for the JSON give frame.
 *
 * Used by both the PUSH path (edges-reconcile-remote.ts, origin dials out)
 * and the ask→accept PULL path (peer-edge-give-route.ts's closure-serve
 * handler, origin answers a fetch) — the same bytes either way.
 */

import { createHash } from "node:crypto";

import type { ShareVaultRef, WireClosure } from "@centraid/vault";

export interface WireDerivativeBlob {
  sha256: string;
  rung: string;
  bytes: string;
}

/** Loose structural check — a full parse is `projectShareClosure`'s job. */
export function isWireClosureShape(value: unknown): value is WireClosure {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.originVaultId === "string" &&
    Array.isArray(v.items) &&
    v.rows !== null &&
    typeof v.rows === "object" &&
    Array.isArray(v.blobs)
  );
}

export function isWireDerivativesShape(
  value: unknown
): value is WireDerivativeBlob[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (entry === null || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      return (
        typeof e.sha256 === "string" &&
        typeof e.rung === "string" &&
        typeof e.bytes === "string"
      );
    })
  );
}

/**
 * Every non-original manifest entry must have arrived with matching,
 * hash-verified bytes — untrusted network input is never adopted into a CAS
 * on the strength of its own say-so. Returns a message describing the first
 * mismatch, or `undefined` when every derivative checks out.
 */
export function verifyDerivatives(
  closure: WireClosure,
  derivatives: readonly WireDerivativeBlob[]
): string | undefined {
  const bySha = new Map(derivatives.map((d) => [d.sha256, d]));
  for (const entry of closure.blobs) {
    if (entry.rung === "original") continue;
    const carried = bySha.get(entry.sha256);
    if (!carried) return `derivative ${entry.sha256} was named but not carried`;
    const digest = createHash("sha256")
      .update(Buffer.from(carried.bytes, "base64"))
      .digest("hex");
    if (digest !== entry.sha256)
      return `derivative ${entry.sha256} bytes do not hash to their name`;
  }
  return undefined;
}

/** Adopt every carried derivative's bytes into the audience CAS. */
export function writeDerivativeBytes(
  audience: ShareVaultRef,
  derivatives: readonly WireDerivativeBlob[]
): void {
  for (const d of derivatives) {
    if (!audience.blobs.local.hasSync(d.sha256)) {
      audience.blobs.local.putSync(d.sha256, Buffer.from(d.bytes, "base64"));
    }
  }
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
