// The receipts list, rendered (#882).
//
// WHAT IT MUST SHOW: the verb, the item, the COLUMNS a reveal opened, the page
// origin of a fill, and a refusal listed like an allowance.
//
// WHAT IT MUST NEVER SHOW: a value. `ACCESS_NO_VALUES` is the promise, and this
// suite is what keeps it true — a receipt carries no value in the first place,
// so the only way one could appear on this screen is a future change deciding
// to fetch it, which this test would fail rather than notice in review.
//
// AND FOUR ANSWERS, NEVER ONE EMPTINESS: not read yet, offline, refused, and
// "no receipt has been written yet" are four different facts.

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  ACCESS_EMPTY,
  ACCESS_ENTRIES,
  ACCESS_HEAD,
  ACCESS_NO_VALUES,
  ACCESS_OFFLINE,
  ACCESS_WHERE,
} from "@centraid/blueprints/apps/locker/route-copy";
import type { LockerAccessEntry } from "@centraid/blueprints/apps/locker/types";

import { mountBlock, nodesOf } from "../../test/react-native-stub";
import LockerAccessView from "./LockerAccessView";

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

/** The value a reveal opened. It is here so the assertions can name what must
 *  never appear; nothing hands it to the component, because nothing could. */
const SECRET = "hunter2";

const REVEAL: LockerAccessEntry = {
  receipt_id: "r1",
  kind: "reveal",
  action: "locker.reveal",
  decision: "allow",
  item_id: "item-1",
  occurred_at: "2026-08-27T09:41:00.000Z",
  columns: ["password"],
};

const REFUSAL: LockerAccessEntry = {
  receipt_id: "r2",
  kind: "auth",
  action: "locker.unlock",
  decision: "deny",
  item_id: null,
  occurred_at: "2026-08-27T09:39:00.000Z",
  reason: "wrong passphrase",
};

const TITLES = new Map([["item-1", "Mail"]]);

function view(
  overrides: Partial<React.ComponentProps<typeof LockerAccessView>> = {}
): React.JSX.Element {
  return (
    <LockerAccessView
      entries={[REVEAL, REFUSAL]}
      error=""
      offline={false}
      titles={TITLES}
      window={{ truncated: false, window: 200 }}
      {...overrides}
    />
  );
}

const textOf = (container: HTMLElement): string => container.textContent ?? "";

describe("the receipts list", () => {
  it("names the act, the item and the columns — and never a value", () => {
    const { container, unmount } = mountBlock(view());
    const text = textOf(container);
    expect(text).toContain(ACCESS_HEAD);
    expect(text).toContain("Revealed");
    expect(text).toContain("Mail");
    // The COLUMN, in the shared model's own word for it.
    expect(text).toContain("password");
    expect(text).not.toContain(SECRET);
    expect(text).toContain(ACCESS_NO_VALUES);
    unmount();
  });

  it("lists a refusal like an allowance, with its own mark", () => {
    const { container, unmount } = mountBlock(view());
    expect(textOf(container)).toContain("REFUSED");
    expect(textOf(container)).toContain("wrong passphrase");
    unmount();
  });

  it("states its window rather than inventing a total", () => {
    const bounded = mountBlock(view());
    expect(textOf(bounded.container)).toContain("2 receipts");
    bounded.unmount();

    const truncated = mountBlock(
      view({ window: { truncated: true, window: 200 } })
    );
    expect(textOf(truncated.container)).toContain("older ones beyond them");
    truncated.unmount();
  });

  it("draws skeleton rows before a read has landed, not day one", () => {
    const { container, unmount } = mountBlock(view({ entries: null }));
    const skeleton = nodesOf(container, "div").find(
      (node) => node.dataset.role === "progressbar"
    );
    expect(skeleton).toBeDefined();
    expect(textOf(container)).not.toContain(ACCESS_EMPTY);
    unmount();
  });

  it("says day one only when a read came back with nothing", () => {
    const { container, unmount } = mountBlock(view({ entries: [] }));
    expect(textOf(container)).toContain(ACCESS_EMPTY);
    unmount();
  });

  it("draws no list over a refusal, and never day one over one", () => {
    const { container, unmount } = mountBlock(
      view({ entries: null, error: "The grant was revoked." })
    );
    expect(textOf(container)).toContain("The grant was revoked.");
    expect(textOf(container)).not.toContain(ACCESS_EMPTY);
    expect(textOf(container)).not.toContain(ACCESS_ENTRIES);
    unmount();
  });

  it("names the journal offline instead of drawing a cached history", () => {
    const { container, unmount } = mountBlock(view({ offline: true }));
    expect(textOf(container)).toContain(ACCESS_OFFLINE);
    // The register above still names the verbs; no ROW is drawn.
    expect(textOf(container)).not.toContain("Mail");
    expect(textOf(container)).not.toContain(ACCESS_ENTRIES);
    unmount();
  });

  it("keeps the sentence naming where the same receipts are read", () => {
    const { container, unmount } = mountBlock(view());
    expect(textOf(container)).toContain(ACCESS_WHERE);
    unmount();
  });
});
