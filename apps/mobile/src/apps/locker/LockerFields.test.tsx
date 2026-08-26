// The field row and the permit gate, rendered (README-Locker §2, §5, §6).
//
// The §6 sentences are VERBATIM here on purpose: this app's whole claim is
// that it states its own boundary in words rather than implying it with a
// lock icon, so a paraphrase is a defect and this is where it fails.
//
//  - a sealed row shows a FIXED dot run whose length never tracks the
//    secret's, and offers Reveal and Copy
//  - a revealed row offers Copy and Conceal, states the remaining time, and
//    says the receipt is ALREADY written — the cost has been paid
//  - the permit gate is a full-stop overlay that names the item, the field,
//    the ~30-second life and the receipt, as four separate sentences
//  - a refusal is shown, because a refusal is receipted too

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { SEALED_RUN } from "@centraid/blueprints/apps/locker/item-fields";
import {
  CONCEAL,
  COPY,
  PERMIT_CANCEL,
  PERMIT_CONFIRM,
  PERMIT_GATE_ASK,
  PERMIT_GATE_LIFE,
  PERMIT_GATE_RECEIPT,
  REVEAL,
  SEALED_NOTE,
  revealedNote,
} from "@centraid/blueprints/apps/locker/view-copy";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import { LockerSealedField } from "./LockerFields";
import LockerPermitGate from "./LockerPermitGate";

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

  it("asks for a permit rather than revealing on its own", () => {
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

describe("the permit gate", () => {
  it("draws nothing until a field is being asked for", () => {
    const { container, unmount } = mountBlock(
      <LockerPermitGate
        busy={false}
        error=""
        field={null}
        itemTitle="Mail"
        onCancel={noop}
        onConfirm={noop}
      />
    );
    expect(textOf(container)).toBe("");
    unmount();
  });

  it("names the item, the field, the permit's life and the receipt", () => {
    const { container, unmount } = mountBlock(
      <LockerPermitGate
        busy={false}
        error=""
        field="password"
        itemTitle="Mail"
        onCancel={noop}
        onConfirm={noop}
      />
    );
    expect(textOf(container)).toContain("Reveal the password?");
    expect(textOf(container)).toContain("Mail");
    expect(textOf(container)).toContain(PERMIT_GATE_ASK);
    expect(textOf(container)).toContain(PERMIT_GATE_LIFE);
    expect(textOf(container)).toContain(PERMIT_GATE_RECEIPT);
    const labels = nodesOf(container, "button").map((node) => node.textContent);
    expect(labels).toContain(PERMIT_CANCEL);
    expect(labels).toContain(PERMIT_CONFIRM);
    unmount();
  });

  it("asks to OPEN an item whose type seals no single field", () => {
    const { container, unmount } = mountBlock(
      <LockerPermitGate
        busy={false}
        error=""
        field="item"
        itemTitle="Passport"
        onCancel={noop}
        onConfirm={noop}
      />
    );
    expect(textOf(container)).toContain("Open this item?");
    unmount();
  });

  it("refuses at rest and shows the host's refusal — a refusal is receipted too", () => {
    const { container, unmount } = mountBlock(
      <LockerPermitGate
        busy={false}
        error="Try again in 12 seconds."
        field="password"
        itemTitle="Mail"
        onCancel={noop}
        onConfirm={noop}
      />
    );
    expect(textOf(container)).toContain("Try again in 12 seconds.");
    const confirm = nodesOf(container, "button").find(
      (node) => node.textContent === PERMIT_CONFIRM
    );
    expect(confirm?.getAttribute("aria-disabled")).toBe("true");
    unmount();
  });
});
