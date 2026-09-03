// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import EmptyBlock from "./EmptyBlock";

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

const colors = resolveTheme("light").colors;

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

const noop = (): void => undefined;
const type = resolveTheme("light").type;

describe(EmptyBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("meets a member once at the display rung, with the filled commit", () => {
    const container = render(
      <EmptyBlock
        action={{ label: "Pair a device", onPress: noop }}
        body="Pair a phone or a laptop to reach this vault from it."
        title="Only this device is enrolled"
      />
    );
    const [title, body] = nodesOf(container, "span");
    expect(styleOf(title ?? null).fontSize).toBe(type.display.fontSize);
    expect(styleOf(body ?? null).fontSize).toBe(type.reading.fontSize);
    expect(
      styleOf(nodesOf(container, "button")[0] ?? null).backgroundColor
    ).toBe(colors.accentFill);
  });

  it("states the routine case quietly", () => {
    const container = render(
      <EmptyBlock
        action={{ label: "Review standing grants", onPress: noop }}
        body="This page is empty most of the time."
        routine
        title="Nothing is waiting on you"
      />
    );
    const [title, body] = nodesOf(container, "span");
    expect(styleOf(title ?? null).fontSize).toBe(type.title.fontSize);
    expect(styleOf(body ?? null).fontSize).toBe(type.body.fontSize);
    expect(
      styleOf(nodesOf(container, "button")[0] ?? null).backgroundColor
    ).toBe("transparent");
  });

  it("draws no verb when the page has nothing to offer", () => {
    const container = render(
      <EmptyBlock
        body="Once automations start doing work."
        routine
        title="Nothing has run yet"
      />
    );
    expect(nodesOf(container, "button")).toHaveLength(0);
  });
});
