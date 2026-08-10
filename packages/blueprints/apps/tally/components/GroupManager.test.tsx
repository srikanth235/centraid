// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { GroupManager } from "./GroupManager.tsx";

describe("Tally group manager departed participants", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  it("labels departed ledger participants without rendering a removal control", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(GroupManager, {
          group: { group_id: "group-trip", name: "Trip" },
          members: [
            {
              party_id: "party-current",
              name: "Sam",
              color: "#111",
              initials: "S",
            },
            {
              party_id: "party-departed",
              name: "Priya",
              color: "#222",
              initials: "P",
              departed: true,
            },
          ],
          friends: [],
          me: "party-owner",
          onRename: () => undefined,
          onAddMember: () => undefined,
          onRemoveMember: () => undefined,
          onDelete: () => undefined,
        })
      );
    });
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });

    expect(container.textContent).toContain("Priya · Departed");
    expect(
      [...container.querySelectorAll("button")].filter(
        (button) => button.textContent === "Remove"
      )
    ).toHaveLength(1);
  });
});
