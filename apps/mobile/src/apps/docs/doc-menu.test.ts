// The quick-actions menu's composition (#821): which verbs a row
// offers is a fact about the document, asserted here as plain data.
import { describe, expect, it, vi } from "vitest";

import type {
  MenuActionRow,
  MenuSubmenuRow,
} from "../../kit/components/AnchoredMenu";
import { buildDocMenu } from "./doc-menu";
import type { DocMenuHandlers } from "./doc-menu";

const folders = [
  { folder_id: "c-property", name: "Property", parent_id: null },
  { folder_id: "c-tax", name: "Tax", parent_id: null },
];

function handlers(): DocMenuHandlers & {
  moveTo: ReturnType<typeof vi.fn<(folderId: string | null) => void>>;
} {
  return {
    share: vi.fn<() => void>(),
    open: vi.fn<() => void>(),
    download: vi.fn<() => void>(),
    versions: vi.fn<() => void>(),
    properties: vi.fn<() => void>(),
    star: vi.fn<() => void>(),
    unstar: vi.fn<() => void>(),
    rename: vi.fn<() => void>(),
    moveTo: vi.fn<(folderId: string | null) => void>(),
    trash: vi.fn<() => void>(),
    restore: vi.fn<() => void>(),
  };
}

const labels = (groups: ReturnType<typeof buildDocMenu>): string[][] =>
  groups.map((group) => group.rows.map((row) => row.label));

describe(buildDocMenu, () => {
  it("offers a trashed row Restore and NOTHING else — no destroy verb exists", () => {
    const groups = buildDocMenu(
      { trashed: true, starred: false, folder_id: null },
      folders,
      handlers()
    );
    expect(labels(groups)).toStrictEqual([["Restore"]]);
  });

  it("composes openings, acts and the outlined-destructive Trash for a live row", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: "c-property" },
      folders,
      handlers()
    );
    // The order and wording `blueprints/apps/docs/popovers.ts` gives the same
    // menu on the web — this seat used to invent shorter labels of its own.
    expect(labels(groups)).toStrictEqual([
      ["Open", "Download"],
      ["Rename", "Move to…", "Star", "Version history", "Details"],
      ["Move to trash"],
    ]);
    const trashRow = groups[2]?.rows[0] as MenuActionRow;
    expect(trashRow.destructive).toBe(true);
  });

  it("swaps Star for Remove star on a starred row", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: true, folder_id: null },
      folders,
      handlers()
    );
    expect(labels(groups)[1]?.[2]).toBe("Remove star");
  });

  it("lists every folder plus the top level in Move to, checking the current filing", () => {
    const on = handlers();
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: "c-tax" },
      folders,
      on
    );
    const move = groups[1]?.rows.find(
      (row) => row.key === "move"
    ) as MenuSubmenuRow;
    expect(move.rows.map((row) => row.label)).toStrictEqual([
      "No folder",
      "Property",
      "Tax",
    ]);
    expect(move.rows.map((row) => row.checked)).toStrictEqual([
      false,
      false,
      true,
    ]);
    move.rows[1]?.onSelect();
    move.rows[0]?.onSelect();
    expect(on.moveTo.mock.calls).toStrictEqual([["c-property"], [null]]);
  });
});

describe("the Share verb", () => {
  it("is ABSENT until the roster answers — never a control that fails on press", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: null },
      folders,
      handlers()
    );
    expect(labels(groups)[0]).toStrictEqual(["Open", "Download"]);
    expect(groups.some((group) => group.key === "reach")).toBe(false);
  });

  it("leads the menu in a group of its own once the roster is an answer", () => {
    const on = handlers();
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: null, canShare: true },
      folders,
      on
    );
    // Grouped by consequence: the one verb that reaches another person stands
    // above the rule, alone.
    expect(labels(groups)).toStrictEqual([
      ["Share"],
      ["Open", "Download"],
      ["Rename", "Move to…", "Star", "Version history", "Details"],
      ["Move to trash"],
    ]);
    const share = groups[0]!.rows[0] as MenuActionRow;
    share.onSelect();
    expect(on.share).toHaveBeenCalledOnce();
  });

  it("is refused on a read-only source — a grant is a write into the vault", () => {
    const groups = buildDocMenu(
      {
        trashed: false,
        starred: false,
        folder_id: null,
        canWrite: false,
        canShare: true,
      },
      folders,
      handlers()
    );
    const share = groups[0]?.rows[0] as MenuActionRow;
    expect(share.label).toBe(
      "Share — This vault is read-only for you, so meaning cannot be written into it."
    );
    expect(share.disabled).toBe(true);
  });

  it("is absent on a trashed row even when the roster answers", () => {
    const groups = buildDocMenu(
      { trashed: true, starred: false, folder_id: null, canShare: true },
      folders,
      handlers()
    );
    expect(labels(groups)).toStrictEqual([["Restore"]]);
  });
});

describe("a read-only source's row", () => {
  const READ_ONLY =
    "This vault is read-only for you, so meaning cannot be written into it.";

  it("keeps Open, Version history and Details — reads never degrade", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: null, canWrite: false },
      folders,
      handlers()
    );
    expect(labels(groups)[0]).toStrictEqual(["Open", "Download"]);
    // The two reads now sit in the acts group, after the verbs; they still
    // carry no refusal, which is the claim this test actually owns.
    const acts = (groups[1]?.rows ?? []) as MenuActionRow[];
    const reads = [
      ...(groups[0]?.rows ?? []),
      ...acts.filter((row) => row.key === "versions" || row.key === "details"),
    ] as MenuActionRow[];
    expect(reads.map((row) => row.label)).toStrictEqual([
      "Open",
      "Download",
      "Version history",
      "Details",
    ]);
    for (const row of reads) expect(row.disabled).toBeUndefined();
  });

  it("disables Star, Rename and Trash together and says why on each", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: null, canWrite: false },
      folders,
      handlers()
    );
    expect(labels(groups)[1]).toStrictEqual([
      `Rename — ${READ_ONLY}`,
      `Move to… — ${READ_ONLY}`,
      `Star — ${READ_ONLY}`,
      "Version history",
      "Details",
    ]);
    expect(labels(groups)[2]).toStrictEqual([`Move to trash — ${READ_ONLY}`]);
    const star = groups[1]?.rows[2] as MenuActionRow;
    const rename = groups[1]?.rows[0] as MenuActionRow;
    const trash = groups[2]?.rows[0] as MenuActionRow;
    expect([star.disabled, rename.disabled, trash.disabled]).toStrictEqual([
      true,
      true,
      true,
    ]);
  });

  it("disables every Move to target, not only the parent row", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: null, canWrite: false },
      folders,
      handlers()
    );
    const move = groups[1]?.rows.find(
      (row) => row.key === "move"
    ) as MenuSubmenuRow;
    expect(move.rows.map((row) => row.disabled)).toStrictEqual([
      true,
      true,
      true,
    ]);
  });

  it("refuses Restore on a trashed row from a source it cannot write", () => {
    const groups = buildDocMenu(
      { trashed: true, starred: false, folder_id: null, canWrite: false },
      folders,
      handlers()
    );
    expect(labels(groups)).toStrictEqual([[`Restore — ${READ_ONLY}`]]);
    const restore = groups[0]?.rows[0] as MenuActionRow;
    expect(restore.disabled).toBe(true);
  });

  it("treats an UNSTAMPED row as the member's own — a missing stamp is not a refusal", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: null },
      folders,
      handlers()
    );
    expect(labels(groups)[1]).toStrictEqual([
      "Rename",
      "Move to…",
      "Star",
      "Version history",
      "Details",
    ]);
  });
});
