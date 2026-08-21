import { describe, expect, it, vi } from "vitest";

import type { MenuActionRow } from "../../kit/components/AnchoredMenu";
import { collectionsMenuGroups } from "./photos-collections-menu";

/** Both rows this module builds are plain action rows, never submenus — one
 *  narrowing helper rather than repeating the type guard in every test. */
function actionRow(
  groups: ReturnType<typeof collectionsMenuGroups>,
  key: string
): MenuActionRow {
  const row = groups[0]!.rows.find((candidate) => candidate.key === key);
  if (!row || !("onSelect" in row))
    throw new Error(`expected an action row for "${key}"`);
  return row;
}

describe("the Collections header menu's model", () => {
  it("carries exactly Show All and Collapse All, in one group", () => {
    const groups = collectionsMenuGroups({
      onCollapseAll: vi.fn<() => void>(),
      onShowAll: vi.fn<() => void>(),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((row) => row.key)).toStrictEqual([
      "show-all",
      "collapse-all",
    ]);
  });

  it("wires Show All to the caller's onShowAll, and nothing else", () => {
    const onShowAll = vi.fn<() => void>();
    const onCollapseAll = vi.fn<() => void>();
    const groups = collectionsMenuGroups({ onCollapseAll, onShowAll });
    actionRow(groups, "show-all").onSelect();
    expect(onShowAll).toHaveBeenCalledOnce();
    expect(onCollapseAll).not.toHaveBeenCalled();
  });

  it("wires Collapse All to the caller's onCollapseAll, and nothing else", () => {
    const onShowAll = vi.fn<() => void>();
    const onCollapseAll = vi.fn<() => void>();
    const groups = collectionsMenuGroups({ onCollapseAll, onShowAll });
    actionRow(groups, "collapse-all").onSelect();
    expect(onCollapseAll).toHaveBeenCalledOnce();
    expect(onShowAll).not.toHaveBeenCalled();
  });

  it("never marks either command as the current answer", () => {
    // Neither row is a persisted preference (see the module's own header
    // comment) — a `checked` mark here would claim a state that resets the
    // moment a member expands one section by hand.
    const groups = collectionsMenuGroups({
      onCollapseAll: vi.fn<() => void>(),
      onShowAll: vi.fn<() => void>(),
    });
    expect(actionRow(groups, "show-all").checked).toBeUndefined();
    expect(actionRow(groups, "collapse-all").checked).toBeUndefined();
  });
});
