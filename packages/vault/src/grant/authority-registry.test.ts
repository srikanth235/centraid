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

  // #928 A3, accepted a wave before its writer: wave 3 mints these rows from
  // the compiled manifest, and the registry is what closes the vocabulary it
  // may mint. An automation is answered about a PACK or an ENTITY TYPE.
  test("an automation is answered about a pack or an entity, read or act", () => {
    for (const subjectType of ["agent.pack", "core.entity"] as const) {
      for (const verb of ["read", "act"] as const)
        expect(
          authorityStrategyFor("automation", subjectType, verb),
          `automation x ${subjectType} x ${verb}`
        ).toBe("execution-clamp");
      expect(registeredVerbs("automation", subjectType)).toStrictEqual([
        "read",
        "act",
      ]);
      // A sealed reveal is Locker's permit, never a standing grant (#873).
      expect(isRegisteredAuthority("automation", subjectType, "reveal")).toBe(
        false
      );
      expect(isRegisteredAuthority("automation", subjectType, "view")).toBe(
        false
      );
    }
    // The subject is a class of rows, not a shareable item.
    expect(authorityTriple("automation", "media.asset")).toBeUndefined();
  });

  // #928 A1: first-party apps are the owner's own screens, so `app` is not a
  // principal kind — and the reserved third-party door stays a type-level
  // absence, never a triple that refuses.
  test("the reserved `app` kind carries no triple at all", () => {
    for (const subjectType of ["agent.pack", "core.entity", "core.vault"])
      expect(authorityTriple("app", subjectType)).toBeUndefined();
    expect(
      AUTHORITY_REGISTRY.some(
        (triple) => (triple.principalKind as string) === "app"
      )
    ).toBe(false);
  });

  test("enforcement locus is derived from the principal, never stored", () => {
    expect(enforcementLocus("harness")).toBe("local");
    // An automation runs in this vault's own engine, like a harness (V-locus).
    expect(enforcementLocus("automation")).toBe("local");
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
