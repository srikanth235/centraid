// The activity ledger is one virtualised list of day headings and rows
// (#922 E6). A heading nested around its rows would pin every open day in
// memory; flattening first is the whole of the change this file pins.
// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { ActivityData } from "@centraid/blueprints/apps/tally/types";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import ActivityView from "./ActivityView";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@shopify/flash-list"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.flashListStub() as unknown as typeof import("@shopify/flash-list");
});

const DATA: ActivityData = {
  me: "party-me",
  currency: "USD",
  activity: [
    {
      kind: "expense",
      date: "2026-09-04",
      description: "Coffee",
      amount_minor: 450,
      paid_by: "party-me",
      paid_by_name: "Me",
    },
    {
      kind: "settlement",
      date: "2026-09-04",
      amount_minor: 1200,
      from_party: "party-a",
      from_name: "Ada",
      to_party: "party-b",
      to_name: "Bea",
    },
  ],
};

describe("the activity ledger as one list", () => {
  it("flattens day headings and both row kinds through the seat list", () => {
    const container = mountBlock(
      <ActivityView
        data={DATA}
        now="2026-09-04T18:00:00.000Z"
        window={20}
        loaded
        notice={{ state: "ready", pending: 0, lastReadAt: null }}
        onShowMore={() => undefined}
      />
    ).container;

    const keys = nodesOf(container, "div")
      .map((node) => node.dataset.row)
      .filter((key) => key !== undefined);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).toContain("Ada paid Bea");
    expect(container.textContent).toContain("Coffee");
  });
});
