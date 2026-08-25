// @vitest-environment jsdom

// Locker's `locker.dayone` cell: what a member sees the first time they open
// the vault, before anything has been put in it.
//
// `src/state-honesty.test.ts` already reads this file's SOURCE and requires the
// kit vocabulary (`kit-empty` + `kit-btn`), and it owns the loading gate — a
// skeleton until the first read settles — so neither is repeated here. What a
// source scan cannot see is which of the two empties the list actually draws:
// `pool.length === 0` is true for a brand-new vault AND for a search that
// matched nothing, and those are opposite situations. Telling a member with 300
// logins that there is "Nothing here" — or offering "Add item" to someone who
// only mistyped a search — is the failure this cell exists to catch, so both
// branches are rendered and contrasted.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";

import { LockerList } from "./components/List.tsx";
import type { LockerRow } from "./types.ts";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ITEM: LockerRow = {
  item_id: "item-1",
  type: "login",
  title: "Bank",
  subtitle: "you@example.com",
};

describe("the Locker list with nothing in it", () => {
  let root: ReturnType<typeof createRoot> | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = undefined;
    document.body.replaceChildren();
  });

  /**
   * Render the list and hand back the container plus the acts its one button
   * actually invoked — a recorded outcome rather than a spy, because the claim
   * is "day one offers the act that FILLS the vault", not "a mock ran".
   */
  async function paint({
    pool = [] as LockerRow[],
    search = "",
  }: { pool?: LockerRow[]; search?: string } = {}): Promise<{
    container: HTMLElement;
    acts: string[];
  }> {
    const acts: string[] = [];
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <LockerList
          pool={pool}
          listTitle="All items"
          allCount={pool.length}
          search={search}
          selectedId={null}
          onOpenSide={() => {}}
          onSelect={() => {}}
          onSearchInput={() => {}}
          onClearSearch={() => void acts.push("clear-search")}
          onNewItem={() => void acts.push("new-item")}
        />
      )
    );
    return { container, acts };
  }

  const text = (container: HTMLElement, selector: string): string | undefined =>
    container.querySelector(selector)?.textContent ?? undefined;

  test("day one names the empty vault and offers the one act that fills it", async () => {
    const { container, acts } = await paint();

    expect(container.querySelector(".kit-empty")).not.toBeNull();
    expect(text(container, ".kit-empty-title")).toBe("Nothing here");
    // The sub-line has to say what CAN go in a locker, because "nothing here"
    // on an app a member has never used reads as a failure to load.
    expect(text(container, ".kit-empty-sub")).toBe(
      "Add a login, card, or note to get started."
    );

    const action = container.querySelector<HTMLButtonElement>(".kit-btn");
    expect(action?.textContent).toBe("Add item");
    await act(async () => action?.click());
    // Exactly the new-item act, so it is not the search-empty act wearing
    // another word.
    expect(acts).toStrictEqual(["new-item"]);
  });

  test("a search that matched nothing is the OTHER empty, with the other act", async () => {
    const { container, acts } = await paint({ search: "x" });

    expect(text(container, ".kit-empty-title")).toBe("No matches");
    expect(text(container, ".kit-empty-sub")).toBe(
      "Try a different search term."
    );
    expect(container.textContent).not.toContain("Nothing here");

    const action = container.querySelector<HTMLButtonElement>(".kit-btn");
    expect(action?.textContent).toBe("Clear search");
    await act(async () => action?.click());
    expect(acts).toStrictEqual(["clear-search"]);
  });

  test("one item is enough to retire the empty state entirely", async () => {
    const { container } = await paint({ pool: [ITEM] });

    expect(container.querySelector(".kit-empty")).toBeNull();
    expect(container.textContent).toContain("Bank");
  });
});
