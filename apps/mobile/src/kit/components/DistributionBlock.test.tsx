// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DISTRIBUTION_FIXTURE } from "@centraid/design/blocks";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import DistributionBlock from "./DistributionBlock";

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

const colors = resolveTheme("light").colors;

let dispose: (() => void) | undefined;

function render(node: React.ReactNode): HTMLElement {
  const mounted = mountBlock(node);
  dispose = mounted.unmount;
  return mounted.container;
}

describe(DistributionBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  it("leads with the biggest share and says every share in words", () => {
    const container = render(
      <DistributionBlock
        accessibilityLabel="Spend by harness"
        rows={DISTRIBUTION_FIXTURE}
        unit="of spend"
      />
    );
    expect(
      nodesOf(container, "span").map((node) => node.textContent)
    ).toStrictEqual([
      "claude-code",
      "73% of spend",
      "$2.50 · 11k",
      "codex",
      "26% of spend",
      "$0.90 · 4k",
      "gemini-cli",
      "1% of spend",
      "<$0.01 · 40",
    ]);
  });

  it("lowers each share to the percentage width string in its style object", () => {
    const container = render(
      <DistributionBlock
        accessibilityLabel="Spend by harness"
        rows={DISTRIBUTION_FIXTURE}
      />
    );
    const fills = nodesOf(container, "div").filter(
      (node) => styleOf(node).backgroundColor === colors.accentFill
    );
    expect(fills.map((node) => styleOf(node).width)).toStrictEqual([
      "73%",
      "26%",
      "1%",
    ]);
  });

  it("spends no colour beyond the recipe's track and fill", () => {
    const container = render(
      <DistributionBlock
        accessibilityLabel="Spend by harness"
        rows={DISTRIBUTION_FIXTURE}
      />
    );
    const grounds = nodesOf(container, "div")
      .map((node) => styleOf(node).backgroundColor)
      .filter((ground): ground is string => typeof ground === "string");
    expect(new Set(grounds)).toStrictEqual(
      new Set([colors.bgElev, colors.bgSunken, colors.accentFill])
    );
    expect(grounds).not.toContain(colors.net);
  });

  it("names the whole breakdown, since a bar says nothing on its own", () => {
    const container = render(
      <DistributionBlock
        accessibilityLabel="Spend by model"
        rows={DISTRIBUTION_FIXTURE}
      />
    );
    expect(
      nodesOf(container, "div").some(
        (node) => node.getAttribute("aria-label") === "Spend by model"
      )
    ).toBe(true);
  });

  it("draws nothing at all for a breakdown with no rows", () => {
    const container = render(
      <DistributionBlock accessibilityLabel="Spend by model" rows={[]} />
    );
    expect(nodesOf(container, "span")).toHaveLength(0);
  });
});
