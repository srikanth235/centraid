import { describe, expect, it } from "vitest";

import {
  FLAGS_SCHEME_URI,
  FOLDER_SCHEME_URI,
  JOURNAL_SCHEME_URI,
  LIST_SCHEME_URI,
  LOCKER_TAGS_SCHEME_URI,
  RELATIONS_SCHEME_URI,
  ROOT_FOLDER_NOTATION,
  STARRED_NOTATION,
  TAGS_SCHEME_URI,
  conceptsInScheme,
  findConcept,
  findScheme,
  findSchemeConcept,
} from "./concept-scheme-kit.ts";

const SCHEMES = [
  { scheme_id: "s-flags", uri: FLAGS_SCHEME_URI },
  { scheme_id: "s-folders", uri: FOLDER_SCHEME_URI },
];

const CONCEPTS = [
  { concept_id: "c-star", scheme_id: "s-flags", notation: STARRED_NOTATION },
  {
    concept_id: "c-root",
    scheme_id: "s-folders",
    notation: ROOT_FOLDER_NOTATION,
  },
  { concept_id: "c-leases", scheme_id: "s-folders", notation: null },
];

describe("the scheme vocabulary", () => {
  it("matches the URIs the vault commands mint", () => {
    // Mirrors of vault's own constants: the blueprint tree may not import
    // vault to check itself, and a drift here is a silently empty shelf.
    expect([
      FLAGS_SCHEME_URI,
      FOLDER_SCHEME_URI,
      LIST_SCHEME_URI,
      LOCKER_TAGS_SCHEME_URI,
      JOURNAL_SCHEME_URI,
      TAGS_SCHEME_URI,
      RELATIONS_SCHEME_URI,
    ]).toStrictEqual([
      "https://centraid.dev/schemes/flags",
      "https://centraid.dev/schemes/folders",
      "https://centraid.dev/schemes/lists",
      "https://centraid.dev/schemes/locker-tags",
      "https://centraid.dev/schemes/people-journal",
      "centraid:tags:v1",
      "urn:duaility:relations",
    ]);
    expect(new Set([FLAGS_SCHEME_URI, TAGS_SCHEME_URI]).size).toBe(2);
  });
});

describe("walking rows", () => {
  it("finds a scheme by URI and answers undefined for one never minted", () => {
    expect(findScheme(SCHEMES, FLAGS_SCHEME_URI)?.scheme_id).toBe("s-flags");
    expect(findScheme(SCHEMES, LIST_SCHEME_URI)).toBeUndefined();
    expect(findScheme(undefined, FLAGS_SCHEME_URI)).toBeUndefined();
  });

  it("keeps concepts inside their own scheme", () => {
    expect(
      conceptsInScheme(CONCEPTS, findScheme(SCHEMES, FOLDER_SCHEME_URI)).map(
        (c) => c.concept_id
      )
    ).toStrictEqual(["c-root", "c-leases"]);
    expect(conceptsInScheme(CONCEPTS, undefined)).toStrictEqual([]);
  });

  it("matches a notation only within the scheme asked for", () => {
    const folders = findScheme(SCHEMES, FOLDER_SCHEME_URI);
    expect(
      findConcept(CONCEPTS, folders, ROOT_FOLDER_NOTATION)?.concept_id
    ).toBe("c-root");
    expect(findConcept(CONCEPTS, folders, STARRED_NOTATION)).toBeUndefined();
    expect(findConcept(CONCEPTS, undefined, STARRED_NOTATION)).toBeUndefined();
  });

  it("resolves scheme and notation in one walk", () => {
    expect(
      findSchemeConcept(SCHEMES, CONCEPTS, FLAGS_SCHEME_URI, STARRED_NOTATION)
        ?.concept_id
    ).toBe("c-star");
    expect(
      findSchemeConcept([], CONCEPTS, FLAGS_SCHEME_URI, STARRED_NOTATION)
    ).toBeUndefined();
  });
});
