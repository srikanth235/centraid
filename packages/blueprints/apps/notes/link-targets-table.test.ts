import { describe, expect, test } from "vitest";

import { apps } from "@centraid/design";

import {
  LINK_TARGET_KINDS,
  NOTE_TARGET_ENTITY,
  linkTargetAppLabel,
  linkTargetsFrom,
} from "./link-targets-table.ts";
import { KIND_ORDER } from "./powerbox.ts";

const notes = LINK_TARGET_KINDS.find(
  (kind) => kind.entity === NOTE_TARGET_ENTITY
)!;

describe("what `[[` may point at", () => {
  test("is the seven kinds the powerbox orders, and no more", () => {
    expect(
      LINK_TARGET_KINDS.map((kind) => linkTargetAppLabel(kind.appId))
    ).toStrictEqual([...KIND_ORDER]);
    expect(KIND_ORDER).toStrictEqual([
      "Notes",
      "People",
      "Agenda",
      "Tasks",
      "Tally",
      "Photos",
      "Docs",
    ]);
  });

  test("every kind names an app the catalog knows — no invented labels", () => {
    for (const kind of LINK_TARGET_KINDS) {
      expect(
        apps.some((app) => app.id === kind.appId),
        `${kind.appId} is not a catalog app`
      ).toBe(true);
    }
  });

  test("never probes Locker — a secret is not a link target", () => {
    for (const kind of LINK_TARGET_KINDS) {
      expect(kind.appId).not.toBe("locker");
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
