// The selection bar's rules, asserted without a renderer (§6, proto:4946).
import { describe, expect, it, vi } from "vitest";

import {
  buildSelectionActions,
  pruneSelection,
  runSelectionBatch,
  selectionBarReason,
  toggleAllSelection,
  toggleSelectionKey,
  toggleSelectionRange,
} from "./selection-engine.ts";
import type { BuildSelectionActionsInput } from "./selection-engine.ts";

const noop = (): void => {};

function input(
  overrides: Partial<BuildSelectionActionsInput> = {}
): BuildSelectionActionsInput {
  return {
    count: 2,
    shelf: "normal",
    readOnlyReason: null,
    favorite: { run: noop },
    addToAlbum: { run: noop },
    share: { run: noop },
    download: { run: noop },
    trash: { run: noop },
    ...overrides,
  };
}

describe("the five", () => {
  it("keeps the handoff's fixed order", () => {
    expect(buildSelectionActions(input()).map((a) => a.id)).toStrictEqual([
      "favorite",
      "add-to-album",
      "share",
      "download",
      "trash",
    ]);
  });

  it("swaps the fifth target on the Trash shelf", () => {
    const base = buildSelectionActions(input()).at(-1);
    const trash = buildSelectionActions(input({ shelf: "trash" })).at(-1);
    expect(base?.label).toBe("Trash");
    expect(base?.destructive).toBe(true);
    expect(trash?.label).toBe("Restore");
    // Restore UNDOES a destructive action rather than being one, so it never
    // takes `--net` (§18).
    expect(trash?.destructive).toBe(false);
  });

  it("swaps the third target on the Sharing shelf", () => {
    const base = buildSelectionActions(input())[2];
    const sharing = buildSelectionActions(input({ shelf: "sharing" }))[2];
    expect(base?.label).toBe("Copy to Sharing");
    expect(sharing?.label).toBe("Remove from Sharing");
  });
});

describe("a refusal is visible, stated, and inert", () => {
  it("disables the three writes on a read-only scope and names why", () => {
    const actions = buildSelectionActions(
      input({ readOnlyReason: "This vault is read-only for you." })
    );
    const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
    // Visible, never hidden — all five are still there.
    expect(actions).toHaveLength(5);
    expect(byId.favorite?.disabled).toBe(true);
    expect(byId["add-to-album"]?.disabled).toBe(true);
    expect(byId.trash?.disabled).toBe(true);
    expect(byId.favorite?.reason).toBe("This vault is read-only for you.");
    // Copying into the member's OWN vault and downloading are not writes on
    // someone else's library, so the grant does not touch them.
    expect(byId.share?.disabled).toBe(false);
    expect(byId.download?.disabled).toBe(false);
  });

  it("SABOTAGE: a disabled control's handler cannot reach the write", () => {
    const favorite = vi.fn<() => void>();
    const trash = vi.fn<() => void>();
    const actions = buildSelectionActions(
      input({
        readOnlyReason: "read-only",
        favorite: { run: favorite },
        trash: { run: trash },
      })
    );
    // Calling `run()` DIRECTLY — the thing a `disabled` prop cannot stop.
    for (const action of actions) action.run();
    expect(favorite).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
  });

  it("keeps a handler-less target visible with the caller's sentence", () => {
    const actions = buildSelectionActions(
      input({ download: { unavailableReason: "Not built for the phone yet." } })
    );
    const download = actions.find((a) => a.id === "download");
    expect(download?.disabled).toBe(true);
    expect(download?.reason).toBe("Not built for the phone yet.");
  });

  it("disables everything when nothing is selected", () => {
    const actions = buildSelectionActions(input({ count: 0 }));
    expect(actions.every((action) => action.disabled)).toBe(true);
  });
});

describe("the one line under the bar", () => {
  it("joins distinct reasons with the system's separator, never an em dash", () => {
    const line = selectionBarReason(
      buildSelectionActions(
        input({
          readOnlyReason: "Read-only.",
          download: { unavailableReason: "No download." },
        })
      )
    );
    expect(line).toBe("Read-only. · No download.");
    expect(line).not.toMatch(/—/u);
  });

  it("is absent when every target can fire", () => {
    expect(selectionBarReason(buildSelectionActions(input()))).toBeUndefined();
  });
});

describe("selection state", () => {
  it("shares toggle, range, all, and prune semantics across seats", () => {
    const one = toggleSelectionKey(new Set(), "b");
    expect([
      ...toggleSelectionRange(one, ["a", "b", "c"], "b", "c"),
    ]).toStrictEqual(["b", "c"]);
    expect([...toggleAllSelection(new Set(), ["a", "b"])]).toStrictEqual([
      "a",
      "b",
    ]);
    expect(pruneSelection(new Set(["a", "gone"]), ["a"])).toStrictEqual(
      new Set(["a"])
    );
  });
});

describe("selection batch isolation", () => {
  it("SABOTAGE: a rejected middle item does not strand the final item", async () => {
    const seen: number[] = [];
    const results = await runSelectionBatch([1, 2, 3], async (target) => {
      seen.push(target);
      if (target === 2) throw new Error("seeded failure");
      return target * 10;
    });
    expect(seen).toStrictEqual([1, 2, 3]);
    expect(results.map((result) => result.status)).toStrictEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  });
});
