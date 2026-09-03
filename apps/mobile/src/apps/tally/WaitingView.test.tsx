import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CONTRIB_EMPTY,
  CONTRIB_SECTIONS,
  CONTRIB_VERBS,
  NUDGE_EMPTY,
} from "@centraid/blueprints/apps/tally/compose-copy";
import { NUDGE_PARKED } from "@centraid/blueprints/apps/tally/view-copy";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { WAITING_OWN_SCOPE } from "./tally-seat-copy";
import { tallyWaiting } from "./tally-view-model";
import WaitingView from "./WaitingView";

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

const OUTBOX = [
  { id: "i1", label: "tally: add-expense", status: "queued" },
  { id: "i2", label: "tally: delete-group", status: "parked" },
  { id: "i3", label: "tally: settle-up", status: "denied", reason: "refused" },
];

function view(
  rows: readonly { id: string; label: string; status: string }[],
  nudges: React.ComponentProps<typeof WaitingView>["nudges"] = []
): { container: HTMLElement; unmount: () => void } {
  return mountBlock(
    <WaitingView
      names={new Map([["ana", "Ana"]])}
      notice={{ lastReadAt: null, pending: rows.length, state: "ready" }}
      nudges={nudges}
      onVerb={noop}
      sections={tallyWaiting(rows, "owner")}
    />
  );
}

describe("the doors this seat has", () => {
  it("draws no Approve and no Decline, because it cannot fire either", () => {
    const { container, unmount } = view(OUTBOX);
    const labels = nodesOf(container, "button").map((node) =>
      node.getAttribute("aria-label")
    );
    expect(labels.join(" ")).not.toContain(CONTRIB_VERBS.approve);
    expect(labels.join(" ")).not.toContain(CONTRIB_VERBS.decline);
    unmount();
  });

  it("says whose writes it is showing, rather than implying it shows all", () => {
    const { container, unmount } = view(OUTBOX);
    expect(container.textContent).toContain(WAITING_OWN_SCOPE);
    unmount();
  });

  it("offers the outbox's own verbs on the rows that permit them", () => {
    const { container, unmount } = view(OUTBOX);
    const labels = nodesOf(container, "button")
      .map((node) => node.getAttribute("aria-label") ?? "")
      .join(" ");
    expect(labels).toContain(CONTRIB_VERBS.cancel);
    expect(labels).toContain(CONTRIB_VERBS.retry);
    unmount();
  });
});

describe("empty is the healthy state", () => {
  it("says which nothing, three times over", () => {
    const { container, unmount } = view([]);
    expect(container.textContent).toContain(CONTRIB_EMPTY.waiting);
    expect(container.textContent).toContain(CONTRIB_EMPTY.inFlight);
    expect(container.textContent).toContain(CONTRIB_EMPTY.ended);
    expect(container.textContent).toContain(NUDGE_EMPTY);
    unmount();
  });

  it("still names all three sections when there is nothing under them", () => {
    const { container, unmount } = view([]);
    for (const label of Object.values(CONTRIB_SECTIONS))
      expect(container.textContent).toContain(label);
    unmount();
  });
});

describe("a reminder", () => {
  it("is prepared, and never said to be sent in any tense", () => {
    const { container, unmount } = view(
      [],
      [
        {
          group_id: null,
          note: null,
          nudge_id: "n1",
          party_id: "ana",
          prepared_at: "2026-08-20T10:00:00.000Z",
          sent: false,
        },
      ]
    );
    expect(container.textContent).toContain(NUDGE_PARKED);
    expect(container.textContent).toContain("Ana");
    expect(container.textContent).not.toMatch(/\bwas sent\b|\bSent\b/u);
    unmount();
  });
});

describe("an unsettled write", () => {
  it("takes the 2px leading rule", () => {
    const { container, unmount } = view(OUTBOX);
    const ruled = nodesOf(container, "div").filter(
      (node) => styleOf(node).borderStartWidth === 2
    );
    expect(ruled.length).toBeGreaterThan(0);
    unmount();
  });
});
// @vitest-environment jsdom
