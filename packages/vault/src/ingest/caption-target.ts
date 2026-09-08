// WHERE A GENERATED CAPTION HANGS (#996, ruling R20(b), OQ-9).
//
// A caption used to be written into `core_content_item.title` — an
// owner-authored column on the sha-deduped byte row — so a machine's words
// replaced the owner's and two assets sharing a sha shared one caption. A
// caption is about how these bytes are being READ, which is precisely what a
// representation is; the owner's own title stays on the wrapper, and
// `media.promote_caption` is the one way a caption becomes one.

import type { DatabaseSync } from "node:sqlite";

import { representationIdOf } from "../schema/representation.js";

/** The entity a caption is keyed to once it is redirected. */
export const REPRESENTATION_TARGET_TYPE = "core.content_representation";

/**
 * Owners whose captions belong on their representation. Anything else — a memo
 * on a person, a remark on a workout — targets what it always did.
 */
const CAPTIONABLE_TARGETS: ReadonlySet<string> = new Set([
  "media.asset",
  "core.document",
  "knowledge.note",
  "core.attachment",
]);

/**
 * The target a caption should actually be stored against. Falls back to the
 * caller's own target when the owner has no representation yet — a caption
 * about bytes nobody is reading has nothing better to hang from.
 */
export function captionTarget(
  vault: DatabaseSync,
  targetType: string,
  targetId: string
): { targetType: string; targetId: string } {
  if (!CAPTIONABLE_TARGETS.has(targetType)) return { targetType, targetId };
  const representationId = representationIdOf(vault, {
    ownerType: targetType,
    ownerId: targetId,
  });
  return representationId
    ? { targetType: REPRESENTATION_TARGET_TYPE, targetId: representationId }
    : { targetType, targetId };
}
