/* What the vault can HONOUR: view = closure reprojection; edit = a SIGNED
 * REPLICA INTENT the origin executes (#929). `locker.item` absent — secrets are
 * never offered as a standing grant, and its sealed columns cannot be re-sealed
 * across a gateway boundary anyway.
 *
 * EDIT IS STILL NARROWER THAN ACTABLE. `tally.group`, `core.document` and
 * `docs.folder` are offered because the intent route executes their declared
 * commands at the origin and the receipt names the member. ALBUMS ARE NOT: a
 * co-contributed photograph is bytes, and the blob path a member's upload would
 * take across the peer plane has not been measured, so offering `edit` here
 * would publish a capability whose cost nobody has read. Both share sheets draw
 * their capability pills straight off this registry, so a wider answer here is
 * a control that cannot fire. */

import type { ShareableItemType } from "../share/closure.js";
import type { ShareGrantCapability } from "./grant-store.js";

export type ShareFulfillmentStrategy =
  | "closure-reprojection"
  | "replica-intent";

export interface ShareSubjectDeclaration {
  subjectType: ShareableItemType;
  fulfillment: {
    view: "closure-reprojection";
    edit?: "replica-intent";
  };
}

export const SHARE_SUBJECT_REGISTRY: readonly ShareSubjectDeclaration[] = [
  {
    subjectType: "core.collection",
    fulfillment: { view: "closure-reprojection" },
  },
  {
    subjectType: "core.content_item",
    fulfillment: { view: "closure-reprojection" },
  },
  {
    subjectType: "core.document",
    fulfillment: { view: "closure-reprojection", edit: "replica-intent" },
  },
  {
    subjectType: "docs.folder",
    fulfillment: { view: "closure-reprojection", edit: "replica-intent" },
  },
  {
    subjectType: "media.asset",
    fulfillment: { view: "closure-reprojection" },
  },
  {
    subjectType: "tally.group",
    fulfillment: { view: "closure-reprojection", edit: "replica-intent" },
  },
];

const BY_SUBJECT = new Map<string, ShareSubjectDeclaration>(
  SHARE_SUBJECT_REGISTRY.map((entry) => [entry.subjectType, entry])
);

/** True for a subject type this vault stands grants over. */
export function isOfferableSubjectType(
  value: string
): value is ShareableItemType {
  return BY_SUBJECT.has(value);
}

export function shareSubjectDeclaration(
  subjectType: string
): ShareSubjectDeclaration | undefined {
  return BY_SUBJECT.get(subjectType);
}

/** Strategy for this capability; `undefined` = not offered. */
export function fulfillmentAnswerFor(
  subjectType: string,
  capability: ShareGrantCapability
): ShareFulfillmentStrategy | undefined {
  const entry = BY_SUBJECT.get(subjectType);
  if (!entry) return undefined;
  return capability === "view"
    ? entry.fulfillment.view
    : entry.fulfillment.edit;
}
