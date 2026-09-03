import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  CREATE_PASSPHRASE,
  DENIED_BODY,
  DENIED_SCOPE,
  DENIED_TITLE,
  LOCK_BODY,
  LOCK_FACTS,
  PASSPHRASE_TOO_SHORT,
  SETUP_BODY,
  SETUP_PLACEHOLDER,
  UNLOCK,
} from "@centraid/blueprints/apps/locker/view-copy";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import { DEVICE_UNLOCK } from "./locker-seat-copy";
import LockerWall from "./LockerWall";

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

function wall(
  overrides: Partial<React.ComponentProps<typeof LockerWall>> = {}
): React.JSX.Element {
  return (
    <LockerWall
      busy={false}
      deviceEnrolled={false}
      error=""
      mode="setup"
      onDeviceUnlock={noop}
      onRevokeDevice={noop}
      onSubmit={noop}
      {...overrides}
    />
  );
}

const textOf = (container: HTMLElement): string => container.textContent ?? "";

describe("the first-run gate", () => {
  it("states the rule before the field, and refuses at rest", () => {
    const { container, unmount } = mountBlock(wall());
    expect(textOf(container)).toContain("Choose a passphrase");
    expect(textOf(container)).toContain(SETUP_BODY);
    const commit = nodesOf(container, "button").find(
      (node) => node.textContent === CREATE_PASSPHRASE
    );
    expect(commit).toBeDefined();
    expect(commit?.getAttribute("aria-disabled")).toBe("true");
    unmount();
  });

  it("refuses a passphrase under the floor and says the floor", () => {
    const submitted: string[] = [];
    const { container, unmount } = mountBlock(
      wall({ onSubmit: (secret) => submitted.push(secret) })
    );
    const field = nodesOf(container, "input")[0];
    expect(field?.getAttribute("aria-label")).toBe(SETUP_PLACEHOLDER);
    const commit = nodesOf(container, "button").find(
      (node) => node.textContent === CREATE_PASSPHRASE
    );
    press(commit);
    expect(submitted).toStrictEqual([]);
    expect(textOf(container)).not.toContain(PASSPHRASE_TOO_SHORT);
    unmount();
  });

  it("draws no facts table — a first run has no session to explain yet", () => {
    const { container, unmount } = mountBlock(wall());
    expect(textOf(container)).not.toContain(LOCK_FACTS[0]?.[1] ?? "");
    unmount();
  });
});

describe("the lock wall", () => {
  it("says what ends a session and carries the facts underneath", () => {
    const { container, unmount } = mountBlock(wall({ mode: "lock" }));
    expect(textOf(container)).toContain("Locked");
    expect(textOf(container)).toContain(LOCK_BODY);
    for (const [key, value] of LOCK_FACTS) {
      expect(textOf(container)).toContain(key);
      expect(textOf(container)).toContain(value);
    }
    unmount();
  });

  it("offers the device credential only once one is enrolled", () => {
    const bare = mountBlock(wall({ mode: "lock" }));
    expect(textOf(bare.container)).not.toContain(DEVICE_UNLOCK);
    bare.unmount();

    const enrolled = mountBlock(wall({ deviceEnrolled: true, mode: "lock" }));
    expect(textOf(enrolled.container)).toContain(DEVICE_UNLOCK);
    enrolled.unmount();
  });

  it("offers its one commit as soon as the field has anything in it", () => {
    const { container, unmount } = mountBlock(wall({ mode: "lock" }));
    const commit = nodesOf(container, "button").find(
      (node) => node.textContent === UNLOCK
    );
    expect(commit?.getAttribute("aria-disabled")).toBe("true");
    unmount();
  });
});

describe("denial", () => {
  it("is a receipt, a scope, and nothing deleted — with no retry", () => {
    const { container, unmount } = mountBlock(wall({ mode: "denied" }));
    expect(textOf(container)).toContain(DENIED_TITLE);
    expect(textOf(container)).toContain(DENIED_BODY);
    expect(textOf(container)).toContain(DENIED_SCOPE);
    expect(nodesOf(container, "button")).toHaveLength(0);
    expect(nodesOf(container, "input")).toHaveLength(0);
    unmount();
  });
});
// @vitest-environment jsdom
