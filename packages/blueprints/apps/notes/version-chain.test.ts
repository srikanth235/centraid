// THE CHAIN IS APPEND-ONLY. These cases are the guard on that claim: a
// restore adds a head and every earlier body is still in the walk afterwards.
import { describe, expect, test } from "vitest";

import type { VaultRow } from "./filing.ts";
import {
  noteVersionChain,
  projectNoteVersions,
  revisesConceptId,
} from "./version-chain.ts";

const SCHEMES = [{ scheme_id: "s-rel", uri: "urn:duaility:relations" }];
const CONCEPTS = [
  { concept_id: "c-revises", scheme_id: "s-rel", notation: "revises" },
  { concept_id: "c-other", scheme_id: "s-rel", notation: "mentions" },
];

const revises = (from: string, to: string, validFrom: string): VaultRow => ({
  link_id: `${from}->${to}`,
  from_type: "core.content_item",
  from_id: from,
  to_type: "core.content_item",
  to_id: to,
  relation_concept_id: "c-revises",
  valid_from: validFrom,
  valid_to: null,
});

const body = (id: string, text: string, createdAt: string): VaultRow => ({
  content_id: id,
  content_uri: `data:text/markdown,${encodeURIComponent(text)}`,
  created_at: createdAt,
});

const LINKS = [
  revises("v3", "v2", "2026-03-03T00:00:00Z"),
  revises("v2", "v1", "2026-02-02T00:00:00Z"),
];

describe("the revises relation", () => {
  test("is resolved by scheme URI and notation, never by position", () => {
    expect(revisesConceptId({ concepts: CONCEPTS, schemes: SCHEMES })).toBe(
      "c-revises"
    );
    expect(revisesConceptId({ concepts: CONCEPTS, schemes: [] })).toBeNull();
  });
});

describe("the version chain", () => {
  test("walks head-first, newest to oldest", () => {
    const chain = noteVersionChain({
      headContentId: "v3",
      links: LINKS,
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(chain.contentIds).toStrictEqual(["v3", "v2", "v1"]);
  });

  test("dates a version by the edge asserted out of it", () => {
    const chain = noteVersionChain({
      headContentId: "v3",
      links: LINKS,
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(chain.assertedAt.get("v3")).toBe("2026-03-03T00:00:00Z");
    expect(chain.assertedAt.get("v1")).toBeUndefined();
  });

  test("ignores edges of another relation and retired ones", () => {
    const chain = noteVersionChain({
      headContentId: "v3",
      links: [
        { ...revises("v3", "v2", "2026-03-03T00:00:00Z"), valid_to: "2026-04" },
        {
          ...revises("v3", "vX", "2026-03-04T00:00:00Z"),
          relation_concept_id: "c-other",
        },
      ],
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(chain.contentIds).toStrictEqual(["v3"]);
  });

  test("stops on a cycle rather than walking forever", () => {
    const chain = noteVersionChain({
      headContentId: "v2",
      links: [...LINKS, revises("v1", "v2", "2026-04-04T00:00:00Z")],
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(chain.contentIds).toStrictEqual(["v2", "v1"]);
  });

  test("a restore APPENDS: nothing the chain held is lost", () => {
    // `restore-note-version` mints a new head whose revises edge points at the
    // body it brings back. The pre-restore chain must survive inside the new.
    const before = noteVersionChain({
      headContentId: "v3",
      links: LINKS,
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    const after = noteVersionChain({
      headContentId: "v4",
      links: [...LINKS, revises("v4", "v3", "2026-05-05T00:00:00Z")],
      concepts: CONCEPTS,
      schemes: SCHEMES,
    });
    expect(after.contentIds).toStrictEqual(["v4", "v3", "v2", "v1"]);
    for (const id of before.contentIds) expect(after.contentIds).toContain(id);
  });
});

describe("the versions a surface draws", () => {
  const chain = noteVersionChain({
    headContentId: "v3",
    links: LINKS,
    concepts: CONCEPTS,
    schemes: SCHEMES,
  });

  test("marks exactly one current, and it is the head", () => {
    const versions = projectNoteVersions({
      chain,
      contents: [
        body("v3", "third", "2026-03-03T00:00:00Z"),
        body("v2", "second", "2026-02-02T00:00:00Z"),
        body("v1", "first", "2026-01-01T00:00:00Z"),
      ],
    });
    expect(versions.map((version) => version.current)).toStrictEqual([
      true,
      false,
      false,
    ]);
    expect(versions.map((version) => version.body)).toStrictEqual([
      "third",
      "second",
      "first",
    ]);
  });

  test("a body this device does not hold reads empty, never invented", () => {
    const versions = projectNoteVersions({
      chain,
      contents: [body("v3", "third", "2026-03-03T00:00:00Z")],
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(versions[2]).toStrictEqual({
      content_id: "v1",
      body: "",
      current: false,
      asserted_at: "2026-01-01T00:00:00Z",
    });
  });
});
