// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { mountBlock, nodesOf, styleOf } from "../../test/react-native-stub";
import { resolveTheme } from "../theme";
import { barColumn, barColumns } from "./bars-model";
import type { BarDatum } from "./bars-model";
import BarsBlock from "./BarsBlock";

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

const day = (key: string, succeeded: number, failed: number): BarDatum => ({
  failed,
  key,
  label: `day ${key}`,
  succeeded,
});

describe("bars lowering", () => {
  it("lowers each column to the percentage strings a style accepts", () => {
    expect(barColumn(day("1", 34, 8))).toStrictEqual({
      failedHeight: "8%",
      hasFailed: true,
      key: "1",
      label: "day 1",
      succeededHeight: "34%",
    });
    expect(barColumn(day("2", 40, 0)).failedHeight).toBeNull();
  });

  it("draws the most recent columns of a long series", () => {
    const series = Array.from({ length: 30 }, (_unused, index) =>
      day(String(index), 40, 0)
    );
    expect(barColumns(series, 10).map((column) => column.key)).toStrictEqual([
      "20",
      "21",
      "22",
      "23",
      "24",
      "25",
      "26",
      "27",
      "28",
      "29",
    ]);
  });
});

describe(BarsBlock, () => {
  afterEach(() => {
    dispose?.();
    dispose = undefined;
  });

  const props = {
    accessibilityLabel: "Runs per day over the last 30 days",
    axis: ["30 days ago", "halfway", "today"] as const,
    legendFailed: "failed",
    legendSucceeded: "succeeded",
  };

  it("spends net on the failure and ink on everything else", () => {
    const container = render(<BarsBlock {...props} data={[day("1", 34, 8)]} />);
    const divs = nodesOf(container, "div");
    const failed = divs.find(
      (node) => styleOf(node).backgroundColor === colors.net
    );
    const succeeded = divs.find(
      (node) => styleOf(node).backgroundColor === colors.textFaint
    );
    expect(styleOf(failed ?? null).height).toBe("8%");
    expect(styleOf(succeeded ?? null).height).toBe("34%");
  });

  it("holds the phone's chart geometry", () => {
    const container = render(<BarsBlock {...props} data={[day("1", 34, 0)]} />);
    const chart = nodesOf(container, "div").find(
      (node) => styleOf(node).height === 116
    );
    expect(styleOf(chart ?? null).gap).toBe(3);
    expect(chart?.getAttribute("aria-label")).toBe(
      "Runs per day over the last 30 days"
    );
    expect(chart?.dataset.role).toBe("image");
  });

  it("draws every column it is given, and tightens the gutter rather than dropping days", () => {
    const month = Array.from({ length: 30 }, (_unused, index) =>
      day(String(index), 40, 0)
    );
    const container = render(<BarsBlock {...props} data={month} />);
    const chart = nodesOf(container, "div").find(
      (node) => styleOf(node).height === 116
    );
    expect(
      nodesOf(container, "div").filter((node) =>
        node.getAttribute("aria-label")?.startsWith("day")
      )
    ).toHaveLength(30);
    expect(styleOf(chart ?? null).gap).toBe(1);
  });

  it("states the peak in words, because the plot has no value axis", () => {
    const container = render(
      <BarsBlock
        {...props}
        data={[day("1", 34, 0)]}
        note="Busiest 14 Aug: $2.40"
      />
    );
    expect(
      nodesOf(container, "span").map((node) => node.textContent)
    ).toContain("Busiest 14 Aug: $2.40");
  });

  it("names each column and each legend key", () => {
    const container = render(
      <BarsBlock {...props} data={[day("1", 34, 8), day("2", 40, 0)]} />
    );
    const named = nodesOf(container, "div")
      .map((node) => node.getAttribute("aria-label"))
      .filter((label) => label?.startsWith("day"));
    expect(named).toStrictEqual(["day 1", "day 2"]);
    const spans = nodesOf(container, "span");
    expect(spans.map((node) => node.textContent)).toStrictEqual([
      "30 days ago",
      "halfway",
      "today",
      "succeeded",
      "failed",
    ]);
    expect(styleOf(spans.at(-1) ?? null).color).toBe(colors.net);
  });
});
