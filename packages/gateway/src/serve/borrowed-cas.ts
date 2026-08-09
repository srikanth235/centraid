/*
 * The borrowed CAS (#726 P4 D5) — the same `blobs/sha256/<aa>/<sha>` layout a
 * vault's own CAS uses, sitting beside the borrowed store and OUTSIDE the
 * sovereign directory the blob sweep walks. Same layout, different address: a
 * sweep, a backup, or a hosted copy that enumerates vault directories cannot
 * reach these bytes, which is the whole enforcement mechanism.
 *
 * VIEWER SEAT (D5). A borrower is not a custodian. Custody is decided by RUNG,
 * not by age or by pressure:
 *
 *   pinned    thumbnails and posters — the tile must paint offline, forever
 *   cached    previews — the first thing reclaimed under pressure
 *   at-origin originals — never held as a duty; reclaimed by the sweep, and
 *             an absent one is an HONEST STATE, not an error
 *
 * That last line is the point of the file. An unreachable original renders as
 * "at <person>'s vault", exactly the way mobile already says "on the gateway"
 * — the borrower never pretends to hold what it does not, and never surfaces
 * someone else's custody decision as a fault of its own.
 */

import { FsBlobStore } from "@centraid/vault";

import type { BorrowedStore } from "./borrowed-store.js";

export type BorrowedCustody = "pinned" | "cached" | "at-origin";

/** Rungs a viewer seat keeps forever. Everything else is reclaimable. */
const PINNED_RUNGS = new Set(["thumb", "thumbnail", "poster"]);
/** Reclaimed BEFORE originals: cheap to re-pull, big enough to be worth it. */
const EVICT_FIRST_RUNGS = new Set(["preview"]);

export function custodyForRung(rung: string): BorrowedCustody {
  if (PINNED_RUNGS.has(rung)) return "pinned";
  return EVICT_FIRST_RUNGS.has(rung) ? "cached" : "at-origin";
}

/**
 * What a borrowed blob IS right now, as a state rather than a success/failure.
 * `at-origin` carries the holder so a surface can render the honest sentence
 * without needing a second lookup.
 */
export type BorrowedBlobState =
  | { state: "resident"; bytes: Buffer }
  | { state: "at-origin"; holder: string };

export class BorrowedCas {
  private constructor(private readonly blobs: FsBlobStore) {}

  static open(root: string): BorrowedCas {
    return new BorrowedCas(new FsBlobStore(root));
  }

  put(
    store: BorrowedStore,
    shapeId: string,
    blob: {
      sha256: string;
      rung: string;
      bytes: Buffer;
    }
  ): BorrowedCustody {
    this.blobs.putSync(blob.sha256, blob.bytes);
    const custody = custodyForRung(blob.rung);
    store.recordBlob(
      shapeId,
      { sha256: blob.sha256, rung: blob.rung, byteSize: blob.bytes.length },
      custody === "at-origin" ? "cached" : custody
    );
    return custody;
  }

  has(sha256: string): boolean {
    return this.blobs.hasSync(sha256);
  }

  /** Same-filesystem temp path for a bounded, resumable pull — the borrowed
   *  CAS's own promotion seam, mirroring a vault CAS's. */
  promotionTempPathSync(sha256: string): string {
    return this.blobs.promotionTempPathSync(sha256);
  }

  /**
   * Adopt a fully-written, hash-verified temp file under its content
   * address — the resumable sibling of {@link put}, for the puller
   * (`lend-blob-pull.ts`) that fills this CAS ranged-chunk by ranged-chunk
   * instead of handing over one whole buffer.
   */
  adoptPulled(
    store: BorrowedStore,
    shapeId: string,
    blob: { sha256: string; rung: string; byteSize: number },
    tempPath: string
  ): BorrowedCustody {
    this.blobs.adoptTempSync(blob.sha256, tempPath);
    const custody = custodyForRung(blob.rung);
    store.recordBlob(
      shapeId,
      { sha256: blob.sha256, rung: blob.rung, byteSize: blob.byteSize },
      custody === "at-origin" ? "cached" : custody
    );
    return custody;
  }

  /**
   * Read a borrowed blob, or say whose vault it is at. The refusal is typed
   * and names a PERSON, never a path or a peer id: the audience is being told
   * where the bytes live, not why a fetch failed.
   */
  read(sha256: string, holder: string): BorrowedBlobState {
    const bytes = this.blobs.getSync(sha256);
    return bytes
      ? { state: "resident", bytes }
      : { state: "at-origin", holder };
  }

  /**
   * Reclaim borrowed bytes, previews first, originals second, pinned never.
   * Returns the shas that left. A viewer seat under pressure gives back the
   * lender's bytes before it gives back anything of its owner's.
   */
  reclaim(
    store: BorrowedStore,
    shapeId: string,
    targetBytes: number
  ): string[] {
    if (targetBytes <= 0) return [];
    const candidates = store
      .blobsOfShape(shapeId)
      .filter((blob) => custodyForRung(blob.rung) !== "pinned")
      .sort((left, right) => rank(left.rung) - rank(right.rung));
    const freed: string[] = [];
    let released = 0;
    for (const blob of candidates) {
      if (released >= targetBytes) break;
      if (!this.blobs.hasSync(blob.sha256)) continue;
      this.blobs.deleteSync(blob.sha256);
      store.setBlobCustody(blob.sha256, "at-origin");
      released += blob.byteSize;
      freed.push(blob.sha256);
    }
    return freed;
  }

  /** Drop bytes no surviving shape refers to — the byte half of `dropShape`. */
  purge(shas: readonly string[]): number {
    let removed = 0;
    for (const sha of shas) {
      if (!this.blobs.hasSync(sha)) continue;
      this.blobs.deleteSync(sha);
      removed += 1;
    }
    return removed;
  }
}

function rank(rung: string): number {
  return custodyForRung(rung) === "cached" ? 0 : 1;
}
