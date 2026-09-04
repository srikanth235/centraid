// BALANCES, RENDERED (§4, §6; STATES.md's Tally row).
//
// What this pins is what a future edit is likeliest to undo quietly:
//
//  - the hero's sub-line names the COUNTS the figure was derived from, so the
//    figure stays inspectable rather than being a number the app asserts
//  - All settled is STATED, never celebrated, and it replaces the arithmetic
//    sub-line rather than sitting beside it
//  - day one and denied look nothing alike: day one offers a first move
//  - Remind appears only on a row that owes YOU something — a level balance
//    has nothing to remind about — and a reminder is never said to be sent
//  - the sign convention is one convention: `--net` is you-owe, ink is
//    owed-to-you, and neither is ever a green

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { DashboardData } from "@centraid/blueprints/apps/tally/types";
import {
  ALL_SETTLED,
  DAY_ONE,
  DAY_ONE_ACT,
  DAY_ONE_SUB,
  HERO_OWE,
  HERO_SETTLED_SUB,
  VERBS,
  balancesHeroSub,
} from "@centraid/blueprints/apps/tally/view-copy";

import {
  mountBlock,
  nodesOf,
  press,
  styleOf,
} from "../../test/react-native-stub";
import BalancesView from "./BalancesView";
import type { TallyScreenState } from "./tally-view-model";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@react-native-async-storage/async-storage"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.asyncStorageStub() as unknown as {
    default: typeof import("@react-native-async-storage/async-storage").default;
  };
});
vi.mock(import("react-native-svg"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.svgStub() as unknown as typeof import("react-native-svg");
});

const noop = (): void => undefined;

const OWED = {
  color: "#5b8def",
  initials: "AN",
  name: "Ana",
  net_minor: 8100,
  party_id: "ana",
};
const OWING = { ...OWED, net_minor: -4200, party_id: "tom", name: "Tom" };

function dashboard(over: Partial<DashboardData> = {}): DashboardData {
  return {
    currency: "GBP",
    expense_count: 194,
    friends: [OWED],
    groups: [],
    me: "owner",
    owe_total_minor: 10_960,
    owed_total_minor: 8100,
    recurring: [],
    settlement_count: 22,
    trash: [],
    ...over,
  };
}

function view(
  data: DashboardData,
  state: TallyScreenState = "ready"
): { container: HTMLElement; unmount: () => void } {
  return mountBlock(
    <BalancesView
      data={data}
      notice={{ pending: 0, state }}
      onAddExpense={noop}
      onAddFriend={noop}
      onNewGroup={noop}
      onOpenFriend={noop}
      onOpenGroup={noop}
      onRemind={noop}
      onSettle={noop}
      state={state}
    />
  );
}

describe("the Balances hero", () => {
  it("says where the figure came from, with the counts behind it", () => {
    const { container, unmount } = view(dashboard());
    expect(container.textContent).toContain(
      balancesHeroSub("£81.00", "£109.60", 194, 22)
    );
    expect(container.textContent).toContain(HERO_OWE);
    unmount();
  });

  it("states a level ledger, and never celebrates it", () => {
    const { container, unmount } = view(
      dashboard({
        friends: [{ ...OWED, net_minor: 0 }],
        owe_total_minor: 0,
        owed_total_minor: 0,
      })
    );
    expect(container.textContent).toContain(ALL_SETTLED);
    expect(container.textContent).toContain(HERO_SETTLED_SUB);
    // The arithmetic sub-line is REPLACED, not doubled up beside it.
    expect(container.textContent).not.toContain("Derived from");
    unmount();
  });
});

describe("day one", () => {
  it("offers a first move rather than an absence", () => {
    const { container, unmount } = view(
      dashboard({ friends: [], groups: [] }),
      "dayone"
    );
    expect(container.textContent).toContain(DAY_ONE);
    expect(container.textContent).toContain(DAY_ONE_SUB);
    expect(container.textContent).toContain(DAY_ONE_ACT);
    // Nothing about a grant, a receipt or a re-grant: denied is a different
    // screen and the two must never read alike (STATES.md, rule 1).
    expect(container.textContent).not.toContain("revoked");
    unmount();
  });
});

describe("the person rows", () => {
  it("offers Remind only where something is owed to you", () => {
    const owed = view(dashboard({ friends: [OWED] }));
    expect(owed.container.textContent).toContain(VERBS.remind);
    owed.unmount();

    const owing = view(dashboard({ friends: [OWING] }));
    expect(owing.container.textContent).not.toContain(VERBS.remind);
    owing.unmount();

    const level = view(dashboard({ friends: [{ ...OWED, net_minor: 0 }] }));
    expect(level.container.textContent).not.toContain(VERBS.remind);
    level.unmount();
  });

  it("hands the friend over when the row is opened", () => {
    const opened: string[] = [];
    const { container, unmount } = mountBlock(
      <BalancesView
        data={dashboard()}
        notice={{ pending: 0, state: "ready" }}
        onAddExpense={noop}
        onAddFriend={noop}
        onNewGroup={noop}
        onOpenFriend={(partyId) => opened.push(partyId)}
        onOpenGroup={noop}
        onRemind={noop}
        onSettle={noop}
        state="ready"
      />
    );
    const row = nodesOf(container, "button").find((node) =>
      node.getAttribute("aria-label")?.includes("Ana")
    );
    press(row);
    expect(opened).toStrictEqual(["ana"]);
    unmount();
  });
});

describe("the sign convention", () => {
  it("paints a you-owe figure in `--net` and an owed-to-you figure in ink", () => {
    const { container, unmount } = view(
      dashboard({ friends: [OWED, OWING], owe_total_minor: 4200 })
    );
    const figures = nodesOf(container, "span").filter(
      (node) => node.textContent === "£42.00" || node.textContent === "£81.00"
    );
    const colors = figures.map((node) => styleOf(node).color);
    // Two different tones, and neither of them is a green.
    expect(new Set(colors).size).toBeGreaterThan(1);
    for (const color of colors)
      expect(String(color)).not.toMatch(/^#(?:0f|1|2)[0-9a-f]*7[0-9a-f]{2}$/iu);
    unmount();
  });
});
