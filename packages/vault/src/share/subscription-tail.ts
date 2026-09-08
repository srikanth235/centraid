/*
 * THE ORIGIN'S DOOR (#996, R10) — the only one a share travels through.
 *
 * A subscriber asks "what changed for this grant since seq N" and gets the
 * three outputs: full images for the rows that entered, the changed columns'
 * rows for the ones that stayed, and a removal for the ones that left. A
 * subscriber with no cursor asks the same question with no `since` and gets
 * every member as an `enter`, which IS the closure snapshot R10 keeps — the
 * same walk, read as a set of rows rather than as a shape. There is no second
 * door: the grant-keyed shape composer stood beside this one for exactly one
 * commit and went when the year-3 convergence gate passed through here.
 *
 * WHAT THIS DOOR CANNOT SERVE it says so about, rather than answering wrongly.
 * A Locker item's sealed columns must be re-sealed under the AUDIENCE DEK,
 * which needs both vault keys in one process; no row on a wire can carry that,
 * so such a grant answers `undefined` and the caller takes the frame door.
 */

import type { DatabaseSync } from "node:sqlite";

import type { ReplicaLogCursor } from "../replica/log.js";
import { shareOutputsAreApplicable } from "./apply-outputs.js";
import { shareClosureMembers } from "./closure-members.js";
import type { ShareClosureOutputs } from "./closure-outputs.js";
import { commitShareClosureDiff, diffShareClosure } from "./closure-outputs.js";
import type { BlobManifestEntry, ShareableItemType } from "./closure.js";
import { readShareClosure } from "./read-closure.js";
import {
  assertClosureWithinCeiling,
  assertSealedColumnsStaySealed,
  shareClosureSizeBytes,
} from "./share-ceiling.js";

/** The frame's own version. Pre-release: an unknown one is refused, not read. */
export const SHARE_TAIL_FORMAT_VERSION = 1;

export interface ShareTailFrame {
  readonly formatVersion: number;
  /** The GRANT. There is no second id (R10). */
  readonly authorityId: string;
  readonly originVaultId: string;
  readonly audienceVaultId: string;
  readonly subjectType: ShareableItemType;
  readonly subjectId: string;
  readonly outputs: ShareClosureOutputs;
  /**
   * The ORIGIN log position every row in this frame is correct AT. One number
   * for the pass rather than one per row: a member's pending write settles once
   * its replica holds the origin's answer at or beyond this seq, and a per-row
   * number would be the same bound written N times.
   */
  readonly originRowVersion: number;
  /** Bytes the audience must hold. Originals only — derived bytes never cross. */
  readonly blobs: readonly BlobManifestEntry[];
  /** What holding this grant costs the audience — the whole closure, not this
   *  pass, because that is what the ceiling is a statement about. */
  readonly sizeBytes: number;
}

export interface ComposeShareTailInput {
  readonly origin: DatabaseSync;
  readonly originVaultId: string;
  readonly audienceVaultId: string;
  readonly authorityId: string;
  readonly subjectType: ShareableItemType;
  readonly subjectId: string;
  /** Where the audience is; absent is a new subscriber. */
  readonly since?: ReplicaLogCursor;
  /** `share_delivery_config`'s ceiling, or the vault-wide default. */
  readonly maxSizeBytes?: number | null;
}

/**
 * One pass: the frame to send, and the `settle` that makes the membership it
 * stands for durable. They are separate because delivery can fail — settling
 * before the audience has the rows would advance the origin's belief about
 * what the audience holds and silently drop the retry. `settle` closes over
 * the member set THIS pass computed, so it can never record a set a second
 * walk produced.
 */
export interface ShareTailPass {
  readonly frame: ShareTailFrame;
  readonly settle: () => void;
}

/**
 * Read-only over the origin. `undefined` when the row applier cannot place
 * what this closure carries — see the header.
 */
export function composeShareTail(
  input: ComposeShareTailInput
): ShareTailPass | undefined {
  const closure = readShareClosure(input.origin, {
    originVaultId: input.originVaultId,
    itemType: input.subjectType,
    itemIds: [input.subjectId],
    // Never a grant to oneself: the origin's own media.location policy applies.
    crossOwner: true,
  });
  const members = shareClosureMembers(input.origin, closure);
  const outputs = diffShareClosure(input.origin, {
    authorityId: input.authorityId,
    members,
    ...(input.since === undefined ? {} : { since: input.since }),
  });
  if (!shareOutputsAreApplicable(outputs)) return undefined;
  // Both properties are judged BEFORE any transport, so an over-ceiling or
  // unsealed grant dials nobody (`share-ceiling.ts`).
  assertSealedColumnsStaySealed([...outputs.enter, ...outputs.update]);
  assertClosureWithinCeiling(input.authorityId, closure, input.maxSizeBytes);
  const sizeBytes = shareClosureSizeBytes(closure);
  const frame: ShareTailFrame = {
    formatVersion: SHARE_TAIL_FORMAT_VERSION,
    authorityId: input.authorityId,
    originVaultId: input.originVaultId,
    audienceVaultId: input.audienceVaultId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    outputs,
    originRowVersion: outputs.cursor.seq,
    blobs: closure.blobs,
    sizeBytes,
  };
  return {
    frame,
    settle: () => commitShareClosureDiff(input.origin, outputs, members),
  };
}
