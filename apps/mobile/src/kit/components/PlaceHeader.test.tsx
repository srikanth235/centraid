// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import PlaceHeader from "./PlaceHeader";

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

describe(PlaceHeader, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("is a title and nothing else when the page has no verbs", () => {
    const container = render(<PlaceHeader title="Notifications" />);
    const [title] = nodesOf(container, "span");
    expect(title?.textContent).toBe("Notifications");
    expect(title?.dataset.role).toBe("header");
    expect(nodesOf(container, "button")).toHaveLength(0);
    expect(
      styleOf(nodesOf(container, "div")[0] ?? null).backgroundColor
    ).toBeUndefined();
  });

  it("orders the quiet verb before the filled commit", () => {
    const container = render(
      <PlaceHeader
        primary={{ label: "Review all", onPress: noop }}
        secondary={{ label: "History", onPress: noop }}
        title="Notifications"
      />
    );
    const [quiet, commit] = nodesOf(container, "button");
    expect(styleOf(quiet ?? null).backgroundColor).toBe("transparent");
    expect(styleOf(commit ?? null).backgroundColor).toBe(colors.accentFill);
  });

  it("lets the caller publish the quiet verb alone", () => {
    const container = render(
      <PlaceHeader
        secondary={{ label: "Export CSV", onPress: noop }}
        title="Analytics"
      />
    );
    expect(nodesOf(container, "button")).toHaveLength(1);
  });
});
