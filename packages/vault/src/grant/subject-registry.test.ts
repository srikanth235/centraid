import { describe, expect, test } from "vitest";

import type { ShareableItemType } from "../share/closure.js";
import {
  CONTAINER_COMMAND_ROUTES,
  isContainerCommandActable,
} from "../share/container-routing.js";
import { SHARE_GRANT_CO_CONTRIBUTION_TYPES } from "./fulfillment-edit.js";
import {
  fulfillmentAnswerFor,
  isOfferableSubjectType,
  SHARE_SUBJECT_REGISTRY,
  shareSubjectDeclaration,
} from "./subject-registry.js";

/** Container types the routing table can actually apply a member write to. */
const ACTABLE_CONTAINER_TYPES = new Set<ShareableItemType>(
  CONTAINER_COMMAND_ROUTES.filter((route) => route.actable).map(
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

  test("edit is offered for the three containers the intent route executes", () => {
    // The registry is what the route publishes and what the share sheets draw
    // pills from, so a wider answer offers a verb the write door refuses. The
    // co-contribution list derives from it (#883), so the value is what is
    // worth asserting. ALBUMS ARE STILL ABSENT (#929): a co-contributed
    // photograph is bytes, and that blob path is unmeasured.
    expect(
      SHARE_SUBJECT_REGISTRY.filter(
        (entry) => entry.fulfillment.edit !== undefined
      ).map((entry) => entry.subjectType)
    ).toStrictEqual([...SHARE_GRANT_CO_CONTRIBUTION_TYPES]);
    expect([...SHARE_GRANT_CO_CONTRIBUTION_TYPES]).toStrictEqual([
      "core.document",
      "docs.folder",
      "tally.group",
    ]);
    expect(fulfillmentAnswerFor("core.collection", "edit")).toBeUndefined();
    expect(fulfillmentAnswerFor("media.asset", "edit")).toBeUndefined();
    expect(fulfillmentAnswerFor("core.document", "view")).toBe(
      "closure-reprojection"
    );
    expect(fulfillmentAnswerFor("docs.folder", "view")).toBe(
      "closure-reprojection"
    );
  });

  test("every edit answer names a container the routing table can act on", () => {
    // Narrower than actable is the ruling; WIDER than actable would be a
    // write the declared table cannot apply — a local mutation the origin's
    // next pass reverts.
    for (const entry of SHARE_SUBJECT_REGISTRY) {
      if (entry.fulfillment.edit === undefined) continue;
      expect(
        ACTABLE_CONTAINER_TYPES.has(entry.subjectType),
        `${entry.subjectType} offers edit without an actable route`
      ).toBe(true);
      expect(fulfillmentAnswerFor(entry.subjectType, "edit")).toBe(
        "replica-intent"
      );
    }
  });

  test("the actable set is the three containers with a declared write surface", () => {
    // A guard on the guard: dropping `actable` everywhere would make the
    // consistency test above pass vacuously.
    expect([...ACTABLE_CONTAINER_TYPES].sort()).toStrictEqual([
      "core.document",
      "docs.folder",
      "tally.group",
    ]);
    expect(isContainerCommandActable("tally.group", "tally.add_expense")).toBe(
      true
    );
    expect(isContainerCommandActable("media.asset", "media.update_asset")).toBe(
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
