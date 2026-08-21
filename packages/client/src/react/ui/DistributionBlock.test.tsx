import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { DISTRIBUTION_FIXTURE } from "@centraid/design/blocks";

import DistributionBlock from "./DistributionBlock.js";

// What this kit must DRAW (#775). The ordering and the share arithmetic are
// asserted once in `packages/design`; these are the marks — the fixed key
// column, the numeric register, and a bar whose width is a ratio the row
// scales rather than a pixel width this renderer computed.

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: JSX.Element): HTMLDivElement {
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(node);
  });
  return container;
}

describe("ui/DistributionBlock", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  it("names the whole breakdown, and each row says its own share in words", () => {
    const el = mount(
      <DistributionBlock
        ariaLabel="Spend by harness"
        rows={DISTRIBUTION_FIXTURE}
        unit="of spend"
      />
    );
    expect(el.querySelector("dl")?.getAttribute("aria-label")).toBe(
      "Spend by harness"
    );
    expect(
      [...el.querySelectorAll(".share")].map((n) => n.textContent)
    ).toStrictEqual(["73% of spend", "26% of spend", "1% of spend"]);
  });

  it("leads with the biggest share — the shared model's order, not the caller's", () => {
    const el = mount(
      <DistributionBlock
        ariaLabel="Spend by harness"
        rows={DISTRIBUTION_FIXTURE}
      />
    );
    expect(
      [...el.querySelectorAll("dt")].map((n) => n.textContent)
    ).toStrictEqual(["claude-code", "codex", "gemini-cli"]);
    expect(
      [...el.querySelectorAll(".amount")].map((n) => n.textContent)
    ).toStrictEqual(["$2.50 · 11k", "$0.90 · 4k", "<$0.01 · 40"]);
  });

  it("expresses a bar as a ratio the row scales, never a pixel width", () => {
    const el = mount(
      <DistributionBlock
        ariaLabel="Spend by harness"
        rows={DISTRIBUTION_FIXTURE}
      />
    );
    const tracks = [...el.querySelectorAll<HTMLElement>(".track")];
    expect(
      tracks.map((n) => n.style.getPropertyValue("--dist-share"))
    ).toStrictEqual(["73", "26", "1"]);
    expect(tracks[0]?.style.width).toBe("");
    // The bar is decoration of the percentage beside it — never a second thing
    // to read, and never announced as work in flight.
    expect(tracks[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(el.querySelector("[role='progressbar']")).toBeNull();
  });

  it("drops the unit when the section head already said it", () => {
    const el = mount(
      <DistributionBlock
        ariaLabel="Spend by model"
        rows={DISTRIBUTION_FIXTURE}
      />
    );
    expect(el.querySelector(".share")?.textContent).toBe("73%");
  });

  it("draws nothing at all for a breakdown with no rows", () => {
    const el = mount(
      <DistributionBlock ariaLabel="Spend by model" rows={[]} />
    );
    expect(el.querySelectorAll(".distRow")).toHaveLength(0);
    expect(el.querySelector("dl")).not.toBeNull();
  });
});
