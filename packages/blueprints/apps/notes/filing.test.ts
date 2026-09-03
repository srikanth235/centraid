import { describe, expect, test } from "vitest";

import {
  notebookIdsOfNote,
  projectNotebooks,
  projectTagShelves,
  tagsOfNote,
  unfiledNoteIds,
} from "./filing.ts";

const COLLECTIONS = [
  { collection_id: "work", name: "Work", sort_order: 2 },
  { collection_id: "home", name: "Home", sort_order: 1 },
];

const ENTRIES = [
  { collection_id: "work", target_type: "knowledge.note", target_id: "n1" },
  { collection_id: "work", target_type: "knowledge.note", target_id: "n2" },
  { collection_id: "home", target_type: "knowledge.note", target_id: "n2" },
  { collection_id: "work", target_type: "core.document", target_id: "d1" },
];

describe("notebook membership", () => {
  test("orders by the vault's own sort order, then by name", () => {
    const shelves = projectNotebooks({
      collections: COLLECTIONS,
      entries: ENTRIES,
    });
    expect(shelves.map((shelf) => shelf.notebook_id)).toStrictEqual([
      "home",
      "work",
    ]);
  });

  test("holds only notes — a document in the same collection is not a member", () => {
    const [, work] = projectNotebooks({
      collections: COLLECTIONS,
      entries: ENTRIES,
    });
    expect(work?.noteIds).toStrictEqual(["n1", "n2"]);
  });

  test("counts only what the place can open (R-journal keeps entries out)", () => {
    const shelves = projectNotebooks({
      collections: COLLECTIONS,
      entries: ENTRIES,
      visible: new Set(["n1"]),
    });
    expect(shelves.map((shelf) => shelf.noteIds)).toStrictEqual([[], ["n1"]]);
  });

  test("a note may be read back to the notebooks holding it", () => {
    const shelves = projectNotebooks({
      collections: COLLECTIONS,
      entries: ENTRIES,
    });
    expect(notebookIdsOfNote("n2", shelves)).toStrictEqual(["home", "work"]);
    expect(notebookIdsOfNote("n9", shelves)).toStrictEqual([]);
  });

  test("unfiled is a real answer, not an absent one", () => {
    const shelves = projectNotebooks({
      collections: COLLECTIONS,
      entries: ENTRIES,
    });
    expect(unfiledNoteIds(["n1", "n2", "n3"], shelves)).toStrictEqual(["n3"]);
  });

  test("a deleted notebook's notes are the ones that become unfiled", () => {
    const shelves = projectNotebooks({
      collections: COLLECTIONS,
      entries: ENTRIES,
    });
    const work = shelves.find((shelf) => shelf.notebook_id === "work");
    expect(work?.noteIds).toHaveLength(2);
  });
});

const CONCEPTS = [
  { concept_id: "c-roadmap", pref_label: "roadmap" },
  { concept_id: "c-admin", pref_label: "admin" },
  { concept_id: "c-journal", pref_label: "entry" },
];

const TAGS = [
  {
    tag_id: "t1",
    concept_id: "c-roadmap",
    target_type: "knowledge.note",
    target_id: "n1",
  },
  {
    tag_id: "t2",
    concept_id: "c-roadmap",
    target_type: "knowledge.note",
    target_id: "n2",
  },
  {
    tag_id: "t3",
    concept_id: "c-admin",
    target_type: "knowledge.note",
    target_id: "n1",
  },
  {
    tag_id: "t4",
    concept_id: "c-journal",
    target_type: "knowledge.note",
    target_id: "j1",
  },
  {
    tag_id: "t5",
    concept_id: "c-roadmap",
    target_type: "core.party",
    target_id: "p1",
  },
];

describe("tag edges", () => {
  test("one shelf per concept, alphabetical, with one edge per tagged note", () => {
    const shelves = projectTagShelves({ tags: TAGS, concepts: CONCEPTS });
    expect(shelves.map((shelf) => shelf.label)).toStrictEqual([
      "admin",
      "entry",
      "roadmap",
    ]);
    expect(
      shelves.find((shelf) => shelf.label === "roadmap")?.edges
    ).toStrictEqual([
      { tag_id: "t1", note_id: "n1" },
      { tag_id: "t2", note_id: "n2" },
    ]);
  });

  test("a concept with no surviving edge is dropped, never shown at zero", () => {
    const shelves = projectTagShelves({
      tags: TAGS,
      concepts: CONCEPTS,
      visible: new Set(["n1", "n2"]),
    });
    expect(shelves.map((shelf) => shelf.label)).toStrictEqual([
      "admin",
      "roadmap",
    ]);
  });

  test("a note's tags carry the edge id removal needs", () => {
    const shelves = projectTagShelves({ tags: TAGS, concepts: CONCEPTS });
    expect(tagsOfNote("n1", shelves)).toStrictEqual([
      { tag_id: "t3", concept_id: "c-admin", label: "admin" },
      { tag_id: "t1", concept_id: "c-roadmap", label: "roadmap" },
    ]);
  });

  test("removing this note's edge leaves the concept and its other notes", () => {
    const remaining = TAGS.filter((tag) => tag.tag_id !== "t1");
    const shelves = projectTagShelves({
      tags: remaining,
      concepts: CONCEPTS,
    });
    expect(tagsOfNote("n1", shelves).map((tag) => tag.label)).toStrictEqual([
      "admin",
    ]);
    expect(
      shelves.find((shelf) => shelf.label === "roadmap")?.edges
    ).toStrictEqual([{ tag_id: "t2", note_id: "n2" }]);
  });
});
