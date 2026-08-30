// The registry is a CLOSURE claim (#883 V-registry), so what it must be tested
// for is the absences: a triple it does not carry cannot be written.

import { describe, expect, test } from "vitest";

import {
  AUTHORITY_REGISTRY,
  authorityStrategyFor,
  authorityTriple,
  enforcementLocus,
  isRegisteredAuthority,
  registeredVerbs,
  subjectWokenBy,
  wakeTypesForSubjectTypes,
} from "./authority-registry.js";
import { SHARE_SUBJECT_REGISTRY } from "./subject-registry.js";

describe("grant/authority-registry", () => {
  test("every share subject declaration reaches both audience kinds, once", () => {
    for (const subject of SHARE_SUBJECT_REGISTRY)
      for (const kind of ["person", "circle"] as const) {
        expect(
          authorityStrategyFor(kind, subject.subjectType, "view"),
          `${kind} x ${subject.subjectType} x view`
        ).toBe(subject.fulfillment.view);
        expect(authorityStrategyFor(kind, subject.subjectType, "edit")).toBe(
          subject.fulfillment.edit
        );
      }
    // One place declares a share verb; this is what proves the two agree.
    const shareTriples = AUTHORITY_REGISTRY.filter(
      (triple) =>
        triple.principalKind === "person" || triple.principalKind === "circle"
    );
    expect(shareTriples).toHaveLength(SHARE_SUBJECT_REGISTRY.length * 2);
  });

  test("a structural exclusion is an ABSENCE, never a triple that refuses", () => {
    // `locker.item` IS shareable and has no triple: secrets are never a
    // standing grant (#750).
    expect(authorityTriple("person", "locker.item")).toBeUndefined();
    expect(isRegisteredAuthority("person", "locker.item", "view")).toBe(false);
    expect(registeredVerbs("person", "locker.item")).toStrictEqual([]);
    // `app` is not a principal kind at all (V-split), and the cast is the
    // point: the compiler refuses the comparison outright.
    expect(
      AUTHORITY_REGISTRY.some(
        (triple) => (triple.principalKind as string) === "app"
      )
    ).toBe(false);
    expect(isRegisteredAuthority("person", "media.asset", "edit")).toBe(false);
    expect(isRegisteredAuthority("person", "media.asset", "comment")).toBe(
      false
    );
    expect(registeredVerbs("person", "media.asset")).toStrictEqual(["view"]);
  });

  test("the plane's own principals carry their own vocabularies", () => {
    expect(authorityStrategyFor("device", "core.vault", "edit")).toBe(
      "device-attenuation"
    );
    expect(
      authorityStrategyFor("device", "core.document", "view")
    ).toBeUndefined();
    const harness = authorityTriple("harness", "enrich.scope");
    expect(harness?.verbs).toMatchObject({ kind: "contract" });
    expect(authorityStrategyFor("harness", "enrich.scope", "ocr")).toBe(
      "enrichment-gate"
    );
  });

  test("enforcement locus is derived from the principal, never stored", () => {
    expect(enforcementLocus("harness")).toBe("local");
    expect(enforcementLocus("device")).toBe("boundary");
    expect(enforcementLocus("person")).toBe("remote");
    expect(enforcementLocus("circle")).toBe("remote");
  });

  test("wake families are per subject type, and a container follows its members", () => {
    expect(subjectWokenBy("core.document", new Set(["media.asset"]))).toBe(
      false
    );
    expect(subjectWokenBy("media.asset", new Set(["media.asset"]))).toBe(true);
    // A grant over an album is membership, not a snapshot (#825 G-membership).
    expect(
      subjectWokenBy("core.collection", new Set(["core.collection_entry"]))
    ).toBe(true);
    expect(subjectWokenBy("core.collection", new Set(["media.asset"]))).toBe(
      true
    );
    expect(
      wakeTypesForSubjectTypes(["core.document"]).has("schedule.task")
    ).toBe(false);
    expect(wakeTypesForSubjectTypes([]).size).toBe(0);
  });
});
