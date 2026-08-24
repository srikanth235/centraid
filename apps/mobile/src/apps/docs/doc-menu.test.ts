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
    open: vi.fn<() => void>(),
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
    expect(labels(groups)).toStrictEqual([
      ["Open", "Versions", "Properties"],
      ["Star", "Rename…", "Move to"],
      ["Trash"],
    ]);
    const trashRow = groups[2]?.rows[0] as MenuActionRow;
    expect(trashRow.destructive).toBe(true);
  });

  it("swaps Star for Unstar on a starred row", () => {
    const groups = buildDocMenu(
      { trashed: false, starred: true, folder_id: null },
      folders,
      handlers()
    );
    expect(labels(groups)[1]?.[0]).toBe("Unstar");
  });

  it("lists every folder plus the top level in Move to, checking the current filing", () => {
    const on = handlers();
    const groups = buildDocMenu(
      { trashed: false, starred: false, folder_id: "c-tax" },
      folders,
      on
    );
    const move = groups[1]?.rows[2] as MenuSubmenuRow;
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
