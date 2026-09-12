// A PLACE spends no colour on itself (#765): the bar is a title and at most
// two verbs, ink only — no app-identity chip, no tint, and (deliberately) no
// count line, which the reference suppresses entirely at phone width.
// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { pageMargin, resolveTheme } from "../theme";
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
    const container = render(<PlaceHeader title="Needs you" />);
    const [title] = nodesOf(container, "span");
    expect(title?.textContent).toBe("Needs you");
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
        title="Needs you"
      />
    );
    const [quiet, commit] = nodesOf(container, "button");
    expect(styleOf(quiet ?? null).backgroundColor).toBe("transparent");
    expect(styleOf(commit ?? null).backgroundColor).toBe(colors.accentFill);
  });

  // #1015 re-audit: neither room that draws this bar pads it, so the bar owns
  // the page gutter, and a 44pt plate centres its one line of label.
  it("keeps the page gutter and centres each verb's label", () => {
    const container = render(
      <PlaceHeader
        primary={{ label: "Review all", onPress: noop }}
        title="Needs you"
      />
    );
    expect(
      styleOf(nodesOf(container, "div")[0] ?? null).paddingHorizontal
    ).toBe(pageMargin);
    const [commit] = nodesOf(container, "button");
    expect(styleOf(commit ?? null).justifyContent).toBe("center");
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
