import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import BarsBlock from "./BarsBlock.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: JSX.Element): HTMLDivElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(node);
  });
  return container;
}

const AXIS = ["30 days ago", "halfway", "today"] as const;
const BARS = [
  { id: "d1", label: "day 1", ok: 34 },
  { id: "d2", label: "1 failed · day 2", fail: 8, ok: 71 },
];

describe("ui/BarsBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("is ONE image to a reader, with a sentence rather than N rectangles", () => {
    const el = mount(
      <BarsBlock
        ariaLabel="Runs per day over the last 30 days"
        axis={AXIS}
        bars={BARS}
      />
    );
    const plot = el.querySelector(".plot") as HTMLElement;
    expect(plot.getAttribute("role")).toBe("img");
    expect(plot.getAttribute("aria-label")).toBe(
      "Runs per day over the last 30 days"
    );
  });

  it("gives each column its own sentence as a title", () => {
    const el = mount(
      <BarsBlock ariaLabel="Runs per day" axis={AXIS} bars={BARS} />
    );
    const titles = [...el.querySelectorAll(".column")].map((n) =>
      n.getAttribute("title")
    );
    expect(titles).toStrictEqual(["day 1", "1 failed · day 2"]);
  });

  it("expresses heights as ratios the column scales, never pixel heights", () => {
    const el = mount(
      <BarsBlock ariaLabel="Runs per day" axis={AXIS} bars={BARS} />
    );
    const second = el.querySelectorAll(".column")[1] as HTMLElement;
    expect(second.style.getPropertyValue("--bar-ok")).toBe("71");
    expect(second.style.getPropertyValue("--bar-fail")).toBe("8");
    expect(second.style.height).toBe("");
  });

  it("draws no failed segment at all when nothing failed", () => {
    const el = mount(
      <BarsBlock ariaLabel="Runs per day" axis={AXIS} bars={BARS} />
    );
    const columns = el.querySelectorAll(".column");
    expect(columns[0]?.querySelector(".fail")).toBeNull();
    expect(columns[1]?.querySelector(".fail")).toBeTruthy();
  });

  it("clamps a height that arrived out of range rather than overflowing the plot", () => {
    const el = mount(
      <BarsBlock
        ariaLabel="Runs per day"
        axis={AXIS}
        bars={[{ fail: 140, id: "x", label: "day 1", ok: -5 }]}
      />
    );
    const column = el.querySelector(".column") as HTMLElement;
    expect(column.style.getPropertyValue("--bar-ok")).toBe("0");
    expect(column.style.getPropertyValue("--bar-fail")).toBe("100");
  });

  it("draws the marks it was given, and does not decide how many there are", () => {
    const el = mount(
      <BarsBlock ariaLabel="Runs per day" axis={AXIS} bars={BARS} />
    );
    expect(
      [...el.querySelectorAll(".axisLabel")].map((n) => n.textContent)
    ).toStrictEqual(["30 days ago", "halfway", "today"]);
    act(() => root?.unmount());
    root = null;
    container?.remove();
    const dated = mount(
      <BarsBlock
        ariaLabel="Spend per day"
        axis={["15 Jul", "14 Aug"]}
        bars={BARS}
      />
    );
    expect(
      [...dated.querySelectorAll(".axisLabel")].map((n) => n.textContent)
    ).toStrictEqual(["15 Jul", "14 Aug"]);
  });

  it("states the peak in words, because the plot has no value axis", () => {
    const el = mount(
      <BarsBlock
        ariaLabel="Spend per day"
        axis={AXIS}
        bars={BARS}
        note="Peak 14 Aug · $2.40 · 12 runs"
      />
    );
    expect(el.querySelector(".note")?.textContent).toBe(
      "Peak 14 Aug · $2.40 · 12 runs"
    );
  });

  it("tightens the gutter rather than dropping columns on a long window", () => {
    const many = Array.from({ length: 90 }, (_unused, i) => ({
      id: `d${i}`,
      label: `day ${i}`,
      ok: 10,
    }));
    const el = mount(
      <BarsBlock ariaLabel="Spend per day" axis={AXIS} bars={many} />
    );
    expect(el.querySelectorAll(".column")).toHaveLength(90);
    expect(el.querySelector<HTMLElement>(".bars")?.dataset.dense).toBe("true");
  });

  it("leaves the gutter alone at one column per day for a month", () => {
    const month = Array.from({ length: 30 }, (_unused, i) => ({
      id: `d${i}`,
      label: `day ${i}`,
      ok: 10,
    }));
    const el = mount(
      <BarsBlock ariaLabel="Spend per day" axis={AXIS} bars={month} />
    );
    expect(
      el.querySelector<HTMLElement>(".bars")?.dataset.dense
    ).toBeUndefined();
  });

  it("names two outcomes in the legend, and only two", () => {
    const el = mount(
      <BarsBlock
        ariaLabel="Runs per day"
        axis={AXIS}
        bars={BARS}
        legend={{ fail: "failed", ok: "succeeded" }}
      />
    );
    const legend = el.querySelector(".legend") as HTMLElement;
    expect(legend.children).toHaveLength(2);
    expect(el.querySelector(".legendOk")?.textContent).toBe("succeeded");
    expect(el.querySelector(".legendFail")?.textContent).toBe("failed");
  });
});
