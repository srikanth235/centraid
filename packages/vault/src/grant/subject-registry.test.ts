import { describe, expect, test } from "vitest";

import type { ShareableItemType } from "../share/closure.js";
import {
  COMMONS_COMMAND_ROUTES,
  isCommonsCommandActable,
} from "../share/commons-routing.js";
import {
  fulfillmentAnswerFor,
  isOfferableSubjectType,
  SHARE_SUBJECT_REGISTRY,
  shareSubjectDeclaration,
} from "./subject-registry.js";

/** Container types the routing table can actually apply a member write to. */
const ACTABLE_CONTAINER_TYPES = new Set<ShareableItemType>(
  COMMONS_COMMAND_ROUTES.filter((route) => route.actable).map(
    (route) => route.containerType
  )
);

describe("grant/subject-registry", () => {
  test("offers exactly the six subject types a strategy can honour", () => {
    expect(
      SHARE_SUBJECT_REGISTRY.map((entry) => entry.subjectType)
    ).toStrictEqual([
      "core.collection",
      "core.content_item",
      "core.document",
      "docs.folder",
      "media.asset",
      "tally.group",
    ]);
    for (const entry of SHARE_SUBJECT_REGISTRY) {
      expect(isOfferableSubjectType(entry.subjectType)).toBe(true);
      expect(entry.fulfillment.view).toBe("closure-reprojection");
    }
  });

  test("locker.item is shareable but deliberately unrepresentable as a grant", () => {
    // It IS a ShareableItemType — the absence below is a refusal, not an
    // oversight, and secrets stay out of the standing-grant vocabulary.
    const locker: ShareableItemType = "locker.item";
    expect(isOfferableSubjectType(locker)).toBe(false);
    expect(shareSubjectDeclaration(locker)).toBeUndefined();
    expect(fulfillmentAnswerFor(locker, "view")).toBeUndefined();
    expect(fulfillmentAnswerFor(locker, "edit")).toBeUndefined();
  });

  test("the edit answer matches the commons routing table's actable facts", () => {
    for (const entry of SHARE_SUBJECT_REGISTRY) {
      expect(
        entry.fulfillment.edit !== undefined,
        `${entry.subjectType} edit vs actable routes`
      ).toBe(ACTABLE_CONTAINER_TYPES.has(entry.subjectType));
    }
    // Stated the other way round: every actable container type the routing
    // table declares is an offerable subject that offers edit.
    for (const containerType of ACTABLE_CONTAINER_TYPES) {
      expect(fulfillmentAnswerFor(containerType, "edit")).toBe(
        "commons-routing"
      );
    }
  });

  test("the actable set is the three containers with a declared write surface", () => {
    // A guard on the guard: were `actable` to be dropped from every route, the
    // consistency test above would pass vacuously.
    expect([...ACTABLE_CONTAINER_TYPES].sort()).toStrictEqual([
      "core.document",
      "docs.folder",
      "tally.group",
    ]);
    expect(isCommonsCommandActable("tally.group", "tally.add_expense")).toBe(
      true
    );
    expect(isCommonsCommandActable("media.asset", "media.update_asset")).toBe(
      false
    );
  });

  test("view is answered for every offerable subject, and unknown types refuse", () => {
    expect(fulfillmentAnswerFor("media.asset", "view")).toBe(
      "closure-reprojection"
    );
    expect(fulfillmentAnswerFor("media.asset", "edit")).toBeUndefined();
    expect(isOfferableSubjectType("knowledge.note")).toBe(false);
    expect(fulfillmentAnswerFor("knowledge.note", "view")).toBeUndefined();
  });
});
