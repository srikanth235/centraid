import type { ReplicaValue } from "@centraid/client/replica/native";
import { describe, expect, it, vi } from "vitest";

import { searchBlueprints } from "./blueprint-search";

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
                },
              },
            ]
          : [],
    }));

    const hits = await searchBlueprints({ search }, "café");

    expect(search).toHaveBeenCalledTimes(8);
    expect(hits).toStrictEqual([
      {
        appId: "notes",
        appLabel: "Notes",
        entity: "knowledge.note",
        id: "note-1",
        label: "旅行 ✨",
        detail: "Plan the Café visit",
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
});
