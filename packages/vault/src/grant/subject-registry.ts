/* What the vault can HONOUR (#750): view = closure reprojection; edit =
 * commons routing where actable. `locker.item` absent — secrets are never
 * offered as a standing grant.
 *
 * EDIT IS NARROWER THAN ACTABLE (#825, ruling G-edit): v1 ships edit
 * co-contribution for `tally.group` alone, and albums and folders are
 * view-capable with their edit strategy deferred. `core.document` and
 * `docs.folder` DO carry actable commons routes, but declaring `edit` here
 * would publish a capability the write door refuses
 * (`SHARE_GRANT_CO_CONTRIBUTION_TYPES` in `fulfillment-edit.ts`) — and both
 * share sheets draw their capability pills straight off this registry, so a
 * wider answer here is a control that cannot fire. */

import type { ShareableItemType } from "../share/closure.js";
import type { ShareGrantCapability } from "./grant-store.js";

export type ShareFulfillmentStrategy =
  | "closure-reprojection"
  | "commons-routing";

export interface ShareSubjectDeclaration {
  subjectType: ShareableItemType;
  fulfillment: {
    view: "closure-reprojection";
    edit?: "commons-routing";
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
    fulfillment: { view: "closure-reprojection" },
  },
  {
    subjectType: "docs.folder",
    fulfillment: { view: "closure-reprojection" },
  },
  {
    subjectType: "media.asset",
    fulfillment: { view: "closure-reprojection" },
  },
  {
    subjectType: "tally.group",
    fulfillment: { view: "closure-reprojection", edit: "commons-routing" },
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
