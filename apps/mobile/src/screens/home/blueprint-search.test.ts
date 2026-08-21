import { describe, expect, it, vi } from "vitest";

import type { ReplicaValue } from "@centraid/client/replica/native";

import { BLUEPRINT_SEARCH_TARGETS, searchBlueprints } from "./blueprint-search";

describe("mobile blueprint search", () => {
  it("fans out to every blueprint and preserves Unicode labels", async () => {
    const search = vi.fn<
      (appId: string) => Promise<{ rows: Array<{ values: ReplicaValue }> }>
    >(async (appId: string) => ({
      rows:
        appId === "notes"
          ? [
              {
                values: {
                  note_id: "note-1",
                  title: "旅行 ✨",
                  _snippet: "Plan the Café visit",
                  updated_at: "2026-07-30T00:00:00.000Z",
                },
              },
            ]
          : [],
    }));

    const hits = await searchBlueprints({ search }, "café");

    expect(search).toHaveBeenCalledTimes(BLUEPRINT_SEARCH_TARGETS.length);
    expect(hits).toStrictEqual([
      {
        appId: "notes",
        appLabel: "Notes",
        appColor: expect.any(String),
        appIconKey: "Book",
        entity: "knowledge.note",
        kind: "note",
        id: "note-1",
        label: "旅行 ✨",
        detail: "Plan the Café visit",
        meta: "2026-07-30T00:00:00.000Z",
      },
    ]);
  });

  it("limits a search to the selected blueprint filter", async () => {
    const search = vi.fn<
      () => Promise<{ rows: Array<{ values: ReplicaValue }> }>
    >(async () => ({ rows: [] }));
    await searchBlueprints({ search }, "旅行", "people");
    expect(search).toHaveBeenCalledExactlyOnceWith("people", {
      entity: "core.party",
      query: "旅行",
      limit: 8,
    });
  });

  it("never targets Locker — its items have no replica shape on mobile", () => {
    expect(
      BLUEPRINT_SEARCH_TARGETS.some((target) => target.appId === "locker")
    ).toBe(false);
  });

  it("only claims a metaField for entities with a confirmed date column", () => {
    const byId = new Map(
      BLUEPRINT_SEARCH_TARGETS.map((target) => [target.appId, target])
    );
    expect(byId.get("agenda")?.metaField).toBe("dtstart");
    expect(byId.get("tasks")?.metaField).toBe("due_at");
    expect(byId.get("notes")?.metaField).toBe("updated_at");
    expect(byId.get("docs")?.metaField).toBe("updated_at");
    expect(byId.get("tally")?.metaField).toBe("spent_on");
    expect(byId.get("people")?.metaField).toBeUndefined();
    expect(byId.get("photos")?.metaField).toBeUndefined();
  });
});
