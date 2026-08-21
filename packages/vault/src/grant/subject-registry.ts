/*
 * What the vault can actually HONOUR, declared once (the #750 pattern: a
 * declared registry, not a remembered list). A subject type is offerable only
 * if some strategy can fulfil it, and the answer differs by capability:
 *
 *   - view is answered by CLOSURE REPROJECTION — the subject's rows are read
 *     as a closure and projected into the audience vault;
 *   - edit is answered by COMMONS ROUTING, and only where the commons routing
 *     table has ACTABLE commands for that container type. Offering edit on a
 *     container nobody can route a write to would accept the gesture and then
 *     silently revert every member edit at the next compile.
 *
 * `locker.item` is a shareable item type and is deliberately ABSENT: secrets
 * are not offered as a standing grant. Its absence here is the refusal.
 */

import type { ShareableItemType } from "../share/closure.js";
import type { ShareGrantCapability } from "./grant-store.js";

/** How a capability is delivered, or `undefined` when it is not offered. */
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
    fulfillment: { view: "closure-reprojection", edit: "commons-routing" },
  },
  {
    subjectType: "docs.folder",
    fulfillment: { view: "closure-reprojection", edit: "commons-routing" },
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

/** True for a subject type this vault will actually stand a grant over. */
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

/**
 * Which strategy answers this capability for this subject, or `undefined`
 * when the pair is not offered at all — the honest refusal a caller should
 * report rather than accepting a grant it cannot keep.
 */
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
