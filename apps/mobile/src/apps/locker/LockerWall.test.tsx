// The two walls, rendered (README-Locker §6; STATES.md Locker).
//
// What this pins is what a future edit is likeliest to undo quietly:
//
//  - THE WALL COLLECTS NOTHING (#996, W6-D2). There is no passphrase field on
//    this screen and there must never be one again: `K` lives in the keychain
//    behind the OS prompt, so an input here would be an app collecting a
//    credential it cannot check and could only forward
//  - the lock wall carries the facts table, so "why did it close on me" is a
//    question asked once
//  - neither wall draws a glyph in place of a sentence (§7)
//  - denial is a receipt, a scope and the fact that nothing was deleted — and
//    it offers NO retry, because there is nothing here to retry

// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";

import {
  DENIED_BODY,
  DENIED_SCOPE,
  DENIED_TITLE,
  LOCK_BODY,
  LOCK_FACTS,
} from "@centraid/blueprints/apps/locker/view-copy";

import { mountBlock, nodesOf, press } from "../../test/react-native-stub";
import {
  DEVICE_ENROL,
  DEVICE_FORGET,
  DEVICE_NOT_ENROLLED_BODY,
  DEVICE_NOT_ENROLLED_TITLE,
  DEVICE_NOTE,
  DEVICE_UNLOCK,
} from "./locker-seat-copy";
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
      error=""
      mode="lock"
      notEnrolled={false}
      onEnrol={noop}
      onForgetKey={noop}
      onUnlock={noop}
      {...overrides}
    />
  );
}

const textOf = (container: HTMLElement): string => container.textContent ?? "";

describe("the lock wall", () => {
  it("collects nothing — there is no field on this screen", () => {
    // The structural half of W6-D2. An input here would be an app collecting a
    // passphrase it cannot check, and forwarding is the only thing it could do
    // with one.
    const { container, unmount } = mountBlock(wall());
    expect(nodesOf(container, "input")).toHaveLength(0);
    expect(textOf(container)).not.toContain("passphrase");
    unmount();
  });

  it("says what ends a session and carries the facts underneath", () => {
    const { container, unmount } = mountBlock(wall());
    expect(textOf(container)).toContain("Locked");
    expect(textOf(container)).toContain(LOCK_BODY);
    for (const [key, value] of LOCK_FACTS) {
      expect(textOf(container)).toContain(key);
      expect(textOf(container)).toContain(value);
    }
    unmount();
  });

  it("offers one way in — the OS prompt — and says what this phone holds", () => {
    const { container, unmount } = mountBlock(wall());
    expect(textOf(container)).toContain(DEVICE_UNLOCK);
    expect(textOf(container)).toContain(DEVICE_NOTE);
    unmount();
  });

  it("unlocks by asking the OS, not by submitting anything", () => {
    const asked = vi.fn<() => void>();
    const { container, unmount } = mountBlock(wall({ onUnlock: asked }));
    const commit = nodesOf(container, "button").find(
      (node) => node.textContent === DEVICE_UNLOCK
    );
    press(commit);
    expect(asked).toHaveBeenCalledOnce();
    unmount();
  });

  it("offers to forget the key — the revoke gesture's local half", () => {
    // Revoke IS rotate on the gateway (R13); here it is "this device stops
    // being able to read", which is the half a member performs on the phone.
    const forget = vi.fn<() => void>();
    const { container, unmount } = mountBlock(wall({ onForgetKey: forget }));
    const commit = nodesOf(container, "button").find(
      (node) => node.textContent === DEVICE_FORGET
    );
    press(commit);
    expect(forget).toHaveBeenCalledOnce();
    unmount();
  });

  it("shows the door's refusal in its own words", () => {
    const { container, unmount } = mountBlock(
      wall({ error: "Face ID was cancelled." })
    );
    expect(textOf(container)).toContain("Face ID was cancelled.");
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

// #1015 B1, then R-NY-19. `storeLockerVaultKey` had no non-test caller, so
// nothing on this seat ever wrote `K` and the wall's one primary refused every
// time it was pressed. The key door is served now and the member asks for it
// HERE, so the wall carries a verb again — a different one, which does the
// thing the absent key needed rather than the thing that could not work.
describe("the lock wall on a phone that holds no key", () => {
  it("offers the enrol verb, not the unlock that could not succeed", () => {
    const { container, unmount } = mountBlock(wall({ notEnrolled: true }));
    const text = textOf(container);
    expect(text).toContain(DEVICE_ENROL);
    expect(text).not.toContain(DEVICE_UNLOCK);
    unmount();
  });

  it("presses the enrol verb, never the unlock one", () => {
    const onEnrol = vi.fn<() => void>();
    const onUnlock = vi.fn<() => void>();
    const { container, unmount } = mountBlock(
      wall({ notEnrolled: true, onEnrol, onUnlock })
    );
    press(container.querySelector('[data-testid="locker-gate-submit"]'));
    expect(onEnrol).toHaveBeenCalledOnce();
    expect(onUnlock).not.toHaveBeenCalled();
    unmount();
  });

  it("offers no Forget either — there is no key on this phone to drop", () => {
    const { container, unmount } = mountBlock(wall({ notEnrolled: true }));
    expect(textOf(container)).not.toContain(DEVICE_FORGET);
    unmount();
  });

  it("says what is true, as the heading, and says it once", () => {
    const { container, unmount } = mountBlock(wall({ notEnrolled: true }));
    const text = textOf(container);
    expect(text).toContain(DEVICE_NOT_ENROLLED_TITLE);
    expect(text.split(DEVICE_NOT_ENROLLED_BODY)).toHaveLength(2);
    unmount();
  });

  it("shows a failed enrolment beside the verb that caused it", () => {
    // The four refusals each name a different repair, so a wall that folded
    // them into the heading would drop the one thing the member needs.
    const { container, unmount } = mountBlock(
      wall({ error: "Enrolling needs your desktop link.", notEnrolled: true })
    );
    expect(textOf(container)).toContain("Enrolling needs your desktop link.");
    unmount();
  });

  it("keeps both verbs on a phone that IS enrolled", () => {
    const { container, unmount } = mountBlock(wall({ notEnrolled: false }));
    expect(textOf(container)).toContain(DEVICE_UNLOCK);
    expect(textOf(container)).toContain(DEVICE_FORGET);
    expect(textOf(container)).not.toContain(DEVICE_ENROL);
    unmount();
  });
});
