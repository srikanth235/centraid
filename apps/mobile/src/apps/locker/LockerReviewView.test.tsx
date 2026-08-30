// Review's two registers, rendered (README-Locker §5, "Review").
//
// The second register is the point, and it is the half a tidy-up would delete:
// a review surface that silently omits what it cannot check is a review
// surface that overstates itself. What this pins:
//
//  - *Needs attention* carries one row per verdict, with its count and its
//    reason
//  - *Checked, and cannot be checked* is always drawn, all clear or not, and
//    carries the gap tags as literal text
//  - ALL CLEAR is a designed screen that says what ran and over how many
//  - nothing to review yet is a THIRD state, distinct from both

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ALL_CLEAR,
  REVIEW_ATTENTION,
  REVIEW_NOTHING,
  REVIEW_UNRUNNABLE,
  UNRUNNABLE_CHECKS,
  allClearBody,
} from "@centraid/blueprints/apps/locker/route-copy";
import type { LockerRow } from "@centraid/blueprints/apps/locker/types";

import { mountBlock } from "../../test/react-native-stub";
import LockerReviewView from "./LockerReviewView";

vi.mock(import("react-native"), async () => {
  const stub = await import("../../test/react-native-stub");
  return {
    ...stub.reactNativeStub(),
    ...stub.flatListStub(),
  } as unknown as typeof import("react-native");
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
const textOf = (container: HTMLElement): string => container.textContent ?? "";

function view(rows: LockerRow[]): React.JSX.Element {
  return (
    <LockerReviewView
      lastReadAt={null}
      onOpen={noop}
      pending={0}
      rows={rows}
      state="ready"
    />
  );
}

const CLEAN: LockerRow = { item_id: "a", type: "login", title: "Mail" };
const WEAK: LockerRow = {
  item_id: "b",
  type: "login",
  title: "Forum",
  weak: true,
};

describe("Review", () => {
  it("draws a verdict row with its count and its reason", () => {
    const { container, unmount } = mountBlock(view([CLEAN, WEAK]));
    expect(textOf(container)).toContain(REVIEW_ATTENTION);
    expect(textOf(container)).toContain("Weak");
    expect(textOf(container)).toContain("Show them");
    expect(textOf(container)).toContain("Forum");
    unmount();
  });

  it("always lists the checks that cannot honestly run, each with its reason", () => {
    for (const rows of [[CLEAN], [CLEAN, WEAK]]) {
      const { container, unmount } = mountBlock(view(rows));
      expect(textOf(container)).toContain(REVIEW_UNRUNNABLE);
      // The surface owes the REASON, in words — never a bracketed gap tag.
      for (const check of UNRUNNABLE_CHECKS) {
        expect(textOf(container)).toContain(check.label);
        expect(textOf(container)).toContain(check.why);
      }
      unmount();
    }
  });

  it("makes all clear a designed screen that accounts for itself", () => {
    const { container, unmount } = mountBlock(view([CLEAN]));
    expect(textOf(container)).toContain(ALL_CLEAR);
    // One item, three checks with a producer that could be answered.
    expect(textOf(container)).toContain(allClearBody(1, 3));
    expect(textOf(container)).not.toContain(REVIEW_ATTENTION);
    unmount();
  });

  it("keeps nothing-to-review-yet distinct from all clear", () => {
    const { container, unmount } = mountBlock(view([]));
    expect(textOf(container)).toContain(REVIEW_NOTHING);
    expect(textOf(container)).not.toContain(ALL_CLEAR);
    unmount();
  });
});
