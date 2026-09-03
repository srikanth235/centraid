// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import SectionBlock from "./SectionBlock";

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

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

describe(SectionBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("holds the label and lets the count truncate", () => {
    const container = render(
      <SectionBlock label="Waiting on you" meta="showing 3 of 12" />
    );
    const [label, meta] = nodesOf(container, "span");
    expect(label?.textContent).toBe("Waiting on you");
    expect(styleOf(label ?? null).flexShrink).toBe(0);
    expect(label?.dataset.lines).toBe("1");
    expect(meta?.textContent).toBe("showing 3 of 12");
    expect(styleOf(meta ?? null).flexShrink).toBe(1);
    expect(meta?.dataset.lines).toBe("1");
  });

  it("draws the label uppercase and the count as tabular numerics", () => {
    const container = render(<SectionBlock label="Runs" meta="1,284 runs" />);
    const [label, meta] = nodesOf(container, "span");
    expect(styleOf(label ?? null).textTransform).toBe("uppercase");
    expect(styleOf(meta ?? null).fontVariant).toStrictEqual(["tabular-nums"]);
  });

  it("renders no count line at all when the caller has none", () => {
    const container = render(<SectionBlock label="Gateway" />);
    expect(nodesOf(container, "span")).toHaveLength(1);
  });
});
