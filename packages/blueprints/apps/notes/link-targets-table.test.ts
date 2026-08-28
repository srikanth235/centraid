// The powerbox's kinds, as a value. Locker's absence and the journal
// exclusion are the two rules this table exists to keep identical on every
// seat, so they are asserted here rather than in each surface.
import { describe, expect, test } from "vitest";

import {
  LINK_TARGET_KINDS,
  NOTE_TARGET_ENTITY,
  linkTargetsFrom,
} from "./link-targets-table.ts";
import { KIND_ORDER } from "./powerbox.ts";

const notes = LINK_TARGET_KINDS.find(
  (kind) => kind.entity === NOTE_TARGET_ENTITY
)!;

describe("what `[[` may point at", () => {
  test("is the seven kinds the powerbox orders, and no more", () => {
    expect(LINK_TARGET_KINDS.map((kind) => kind.app)).toStrictEqual([
      ...KIND_ORDER,
    ]);
  });

  test("never probes Locker — a secret is not a link target", () => {
    for (const kind of LINK_TARGET_KINDS) {
      expect(kind.app).not.toBe("Locker");
      expect(kind.entity.startsWith("locker.")).toBe(false);
    }
  });
});

describe("rows as targets", () => {
  test("carries the id, the first non-empty label, and the kind", () => {
    expect(
      linkTargetsFrom(notes, [
        { note_id: "n1", title: " Roadmap ", preview: "the plan" },
      ])
    ).toStrictEqual([
      {
        type: "knowledge.note",
        id: "n1",
        title: "Roadmap",
        subtitle: "the plan",
        app: "Notes",
      },
    ]);
  });

  test("drops a row with no title — an unnamed target cannot be picked", () => {
    expect(
      linkTargetsFrom(notes, [{ note_id: "n1", title: "  " }])
    ).toStrictEqual([]);
  });

  test("falls back to the kind's own name when no subtitle field answers", () => {
    const [target] = linkTargetsFrom(notes, [{ note_id: "n1", title: "A" }]);
    expect(target?.subtitle).toBe("Notes");
  });

  test("excludes journal entries (R-journal) without touching other kinds", () => {
    const rows = [
      { note_id: "n1", title: "Roadmap" },
      { note_id: "j1", title: "Tuesday with Ravi" },
    ];
    expect(
      linkTargetsFrom(notes, rows, new Set(["j1"])).map((target) => target.id)
    ).toStrictEqual(["n1"]);
  });
});
