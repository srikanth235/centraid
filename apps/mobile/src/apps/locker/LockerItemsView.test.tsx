// The item list's designed states, rendered (STATES.md's Locker / Items row).
//
// What this pins:
//
//  - LOADING IS SKELETON ROWS at the list's own geometry, never a spinner and
//    never an empty list
//  - DAY ONE IS AN INVITATION with two ways in — and it is a different screen
//    from a filter that matched nothing
//  - the offline notice names what still works AND why a secret does not
//  - the window's foot states what it is showing and offers *Show more* only
//    where the read said there is more
//  - the device-credential offer appears only where this phone can hold one

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import type { LockerRow } from "@centraid/blueprints/apps/locker/types";
import {
  DAY_ONE_ADD,
  DAY_ONE_BODY,
  DAY_ONE_IMPORT,
  DAY_ONE_TITLE,
  NO_MATCH,
  OFFLINE_NOTICE,
  OFFLINE_WHY_BODY,
  SHOW_MORE,
  pendingNotice,
} from "@centraid/blueprints/apps/locker/view-copy";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import { DEVICE_OFFER } from "./locker-seat-copy";
import LockerItemsView from "./LockerItemsView";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.reactNativeStub() as unknown as typeof import("react-native");
});
vi.mock(import("@shopify/flash-list"), async () => {
  const stub = await import("../../test/react-native-stub");
  return stub.flashListStub() as unknown as typeof import("@shopify/flash-list");
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
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

const noop = (): void => undefined;

const ROWS: LockerRow[] = [
  {
    item_id: "a",
    type: "login",
    title: "Mail",
    subtitle: "me@example.test",
    weak: true,
  },
  { item_id: "b", type: "card", title: "Bank card", subtitle: "•••• 4417" },
];

function view(
  overrides: Partial<React.ComponentProps<typeof LockerItemsView>> = {}
): React.JSX.Element {
  return (
    <LockerItemsView
      filter={{ kind: "all" }}
      lastReadAt="2026-08-26T09:41:00.000Z"
      loaded
      offerDevice={false}
      onEnrolDevice={noop}
      onFilter={noop}
      onImport={noop}
      onNew={noop}
      onOpen={noop}
      onShowMore={noop}
      pending={0}
      rows={ROWS}
      state="ready"
      truncated={false}
      {...overrides}
    />
  );
}

const textOf = (container: HTMLElement): string => container.textContent ?? "";

describe("the item list", () => {
  it("draws skeleton rows while the read has not landed", () => {
    const { container, unmount } = mountBlock(
      view({ loaded: false, rows: [], state: "loading" })
    );
    const skeleton = nodesOf(container, "div").find(
      (node) => node.dataset.role === "progressbar"
    );
    expect(skeleton).toBeDefined();
    expect(textOf(container)).not.toContain(DAY_ONE_TITLE);
    unmount();
  });

  it("offers two ways in on day one, and not the no-match line", () => {
    const { container, unmount } = mountBlock(
      view({ rows: [], state: "dayone" })
    );
    expect(textOf(container)).toContain(DAY_ONE_TITLE);
    expect(textOf(container)).toContain(DAY_ONE_BODY);
    expect(textOf(container)).toContain(DAY_ONE_ADD);
    expect(textOf(container)).toContain(DAY_ONE_IMPORT);
    expect(textOf(container)).not.toContain(NO_MATCH);
    unmount();
  });

  it("separates a filter that matched nothing from a vault with nothing in it", () => {
    const { container, unmount } = mountBlock(
      view({ filter: { kind: "starred" }, state: "ready" })
    );
    expect(textOf(container)).toContain(NO_MATCH);
    expect(textOf(container)).not.toContain(DAY_ONE_TITLE);
    unmount();
  });

  it("names what still works offline, and why a secret does not", () => {
    const { container, unmount } = mountBlock(view({ state: "offline" }));
    expect(textOf(container)).toContain(OFFLINE_NOTICE);
    expect(textOf(container)).toContain(OFFLINE_WHY_BODY);
    unmount();
  });

  it("counts queued metadata writes and promises no secret among them", () => {
    const { container, unmount } = mountBlock(
      view({ pending: 2, state: "pending" })
    );
    expect(textOf(container)).toContain(pendingNotice(2));
    expect(textOf(container)).toContain("no secret is ever queued");
    unmount();
  });

  it("names the steward a parked write waits on, in place of the count", () => {
    const { container, unmount } = mountBlock(
      view({
        pending: 1,
        state: "parked",
        waiting: "Waiting for Ravi.",
      })
    );
    expect(textOf(container)).toContain("Waiting for Ravi.");
    unmount();
  });

  it("keeps the counting sentence where the outbox can name no wait", () => {
    const { container, unmount } = mountBlock(
      view({ pending: 2, state: "pending", waiting: null })
    );
    expect(textOf(container)).toContain(pendingNotice(2));
    unmount();
  });

  it("offers Show more only where the read said there is more", () => {
    const bounded = mountBlock(view());
    expect(textOf(bounded.container)).toContain("2 in the vault");
    expect(textOf(bounded.container)).not.toContain(SHOW_MORE);
    bounded.unmount();

    const truncated = mountBlock(view({ truncated: true }));
    expect(textOf(truncated.container)).toContain("older items beyond them");
    expect(textOf(truncated.container)).toContain(SHOW_MORE);
    truncated.unmount();
  });

  it("offers a device credential only where this phone can hold one", () => {
    const without = mountBlock(view());
    expect(textOf(without.container)).not.toContain(DEVICE_OFFER);
    without.unmount();

    const offered = mountBlock(view({ offerDevice: true }));
    expect(textOf(offered.container)).toContain(DEVICE_OFFER);
    offered.unmount();
  });

  it("draws each row's verdict from the shared derivation", () => {
    const { container, unmount } = mountBlock(view());
    expect(textOf(container)).toContain("WEAK");
    expect(textOf(container)).toContain("Mail");
    expect(textOf(container)).toContain("Bank card");
    unmount();
  });
});
