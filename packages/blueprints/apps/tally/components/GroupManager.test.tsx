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
    (window as unknown as { centraid?: unknown }).centraid = undefined;
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

// Issue #731 M3: a tally.group container is bound to its OWN named commons
// circle server-side, so any share of it is checked against that circle's
// EXACT stored roster + capabilities regardless of what the sheet submits.
// Opening the sheet with nothing preselected used to default every new pick
// to `read+write`, which refused with the commons layer's exact-roster
// message the instant that drifted from a pre-#731-migration `read` roster.
// `GroupManager` now hands the ShareSheet the group's own name as
// `preferredCircleLabel` — `GroupMeta.name` is read straight off the
// circle's own `social.circle.name` (dashboard.ts), so it doubles as that
// circle's `ShareCircle.label` and lets the sheet auto-select it.
describe("Tally group manager sharing (#731 M3)", () => {
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  it("preselects the group's own named circle, sourcing each member's STORED capability instead of defaulting to read+write", async () => {
    (window as unknown as { centraid: unknown }).centraid = {
      shareTargets: () =>
        Promise.resolve([{ partyId: "party-current", label: "Sam" }]),
      shareCircles: () =>
        Promise.resolve([
          {
            circleId: "circle-trip",
            label: "Trip",
            members: [{ partyId: "party-current", capability: "read" }],
          },
        ]),
    };

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
    // Open "Manage group", then "Share group".
    await act(async () => {
      (container.querySelector("button") as HTMLButtonElement).click();
    });
    const shareButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Share group"
    ) as HTMLButtonElement;
    await act(async () => {
      shareButton.click();
    });
    // Let the ShareSheet's load effect (destinations + circles, both
    // already-resolved promises) settle.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const circleSelect = container.querySelector(
      "select"
    ) as HTMLSelectElement | null;
    expect(circleSelect?.value).toBe("circle-trip");
    expect(container.textContent).toContain(
      "Sharing with Trip's existing members"
    );
    const capabilitySelect = container.querySelector(
      'select[aria-label="Sam capability"]'
    ) as HTMLSelectElement | null;
    expect(capabilitySelect?.value).toBe("read");
  });
});
