// The field row, rendered (README-Locker §2, §5, §6).
//
// The §6 sentences are VERBATIM here on purpose: this app's whole claim is
// that it states its own boundary in words rather than implying it with a
// lock icon, so a paraphrase is a defect and this is where it fails.
//
//  - a sealed row shows a FIXED dot run whose length never tracks the
//    secret's, and offers Reveal and Copy
//  - a revealed row offers Copy and Conceal, states the remaining time, and
//    says the receipt is ALREADY written — the cost has been paid
//  - REVEAL ASKS, IT DOES NOT OPEN. The overlay it used to raise is gone with
//    the permit (#996, W6-D2): the ask goes to the shell's door, which prompts
//    the OS if the session has lapsed and answers otherwise. What this still
//    pins is that the row itself reveals nothing on its own.

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { SEALED_RUN } from "@centraid/blueprints/apps/locker/item-fields";
import {
  CONCEAL,
  COPY,
  REVEAL,
  SEALED_NOTE,
  revealedNote,
} from "@centraid/blueprints/apps/locker/view-copy";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import { LockerSealedField } from "./LockerFields";

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
vi.mock(import("react-native-safe-area-context"), () => ({
  useSafeAreaInsets: () => ({ bottom: 34, left: 0, right: 0, top: 47 }),
}));

const noop = (): void => undefined;
const textOf = (container: HTMLElement): string => container.textContent ?? "";
const NOW = 1_772_000_000_000;

describe("a sealed field", () => {
  it("wears a fixed dot run and carries the §6 sealed note verbatim", () => {
    const { container, unmount } = mountBlock(
      <LockerSealedField
        field="password"
        label="Password"
        now={NOW}
        onConceal={noop}
        onCopy={noop}
        onReveal={noop}
        revealed={null}
        revealedAt={null}
      />
    );
    expect(textOf(container)).toContain(SEALED_RUN);
    expect(textOf(container)).toContain(SEALED_NOTE);
    const labels = nodesOf(container, "button").map((node) => node.textContent);
    expect(labels).toStrictEqual([REVEAL, COPY]);
    unmount();
  });

  it("asks the shell's door rather than revealing on its own", () => {
    const asked: string[] = [];
    const { container, unmount } = mountBlock(
      <LockerSealedField
        field="password"
        label="Password"
        now={NOW}
        onConceal={noop}
        onCopy={noop}
        onReveal={(field) => asked.push(field)}
        revealed={null}
        revealedAt={null}
      />
    );
    press(
      nodesOf(container, "button").find((node) => node.textContent === REVEAL)
    );
    expect(asked).toStrictEqual(["password"]);
    unmount();
  });

  it("states the remaining time and that the receipt is already written", () => {
    const { container, unmount } = mountBlock(
      <LockerSealedField
        field="password"
        label="Password"
        now={NOW + 4000}
        onConceal={noop}
        onCopy={noop}
        onReveal={noop}
        revealed="hunter2"
        revealedAt={NOW}
      />
    );
    expect(textOf(container)).toContain("hunter2");
    expect(textOf(container)).toContain(revealedNote(4, 26));
    expect(textOf(container)).toContain("the receipt is already written");
    const labels = nodesOf(container, "button").map((node) => node.textContent);
    expect(labels).toStrictEqual([COPY, CONCEAL]);
    unmount();
  });
});
