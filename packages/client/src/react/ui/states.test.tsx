import { act } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevicesDisagree, OutOfRoom, WorkingState } from "./states.js";

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

describe("ui/states", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  describe(WorkingState, () => {
    it("is determinate with EXACT counts, never a spinner", () => {
      const el = mount(
        <WorkingState
          label="Indexing your photos"
          progress={{ done: 2_340, total: 11_205, unit: "photos" }}
        />
      );
      expect(el.querySelector(".workingCounts")?.textContent).toBe(
        `${(2_340).toLocaleString()} of ${(11_205).toLocaleString()} photos`
      );
      expect(el.querySelector("section")?.getAttribute("aria-live")).toBe(
        "polite"
      );
      expect(el.querySelector(".workingTrack")?.ariaHidden).toBe("true");
      expect(el.querySelector(".workingTrack")).toBeTruthy();
    });

    it("expresses progress as a ratio the track scales, not a pixel width", () => {
      const fill = mount(
        <WorkingState label="Indexing" progress={{ done: 1, total: 4 }} />
      ).querySelector(".workingFill") as HTMLElement;
      expect(fill.style.getPropertyValue("--working-progress")).toBe("0.25");
      expect(fill.style.width).toBe("");
    });

    it("survives a zero total rather than dividing by it", () => {
      const fill = mount(
        <WorkingState label="Indexing" progress={{ done: 0, total: 0 }} />
      ).querySelector(".workingFill") as HTMLElement;
      expect(fill.style.getPropertyValue("--working-progress")).toBe("0");
    });

    it("shows STATIC skeletons and drops the bar when the total is unknown", () => {
      const el = mount(<WorkingState label="Reading" skeletonRows={3} />);
      expect(el.querySelectorAll(".skeleton")).toHaveLength(3);
      expect(el.querySelector(".workingTrack")).toBeNull();
      expect(el.querySelector(".workingCounts")).toBeNull();
    });

    it("leaves the surrounding app usable — it is inline, not an overlay", () => {
      const el = mount(
        <div>
          <WorkingState label="Indexing" progress={{ done: 1, total: 2 }} />
          <button type="button">Still clickable</button>
        </div>
      );
      const other = el.querySelector("button") as HTMLButtonElement;
      expect(other.disabled).toBe(false);
      expect(el.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  describe(DevicesDisagree, () => {
    const versions = [
      { at: "2:14 PM", body: "Milk, eggs, bread", device: "MacBook Pro" },
      { at: "2:31 PM", body: "Milk, eggs, coffee", device: "iPhone" },
    ] as const;
    const choices = [
      { id: "mine", label: "Keep MacBook Pro’s" },
      { id: "theirs", label: "Keep iPhone’s" },
      { id: "both", label: "Keep both" },
    ];

    it("shows BOTH versions with device name and time", () => {
      const el = mount(
        <DevicesDisagree
          choices={choices}
          onChoose={vi.fn<() => void>()}
          subject="Grocery list"
          versions={versions}
        />
      );
      const cards = el.querySelectorAll(".version");
      expect(cards).toHaveLength(2);
      expect(
        [...cards].map((c) => c.querySelector(".versionDevice")?.textContent)
      ).toStrictEqual(["MacBook Pro", "iPhone"]);
      expect(
        [...cards].map((c) => c.querySelector(".versionAt")?.textContent)
      ).toStrictEqual(["2:14 PM", "2:31 PM"]);
      expect(
        [...cards].map((c) => c.querySelector(".versionBody")?.textContent)
      ).toStrictEqual(["Milk, eggs, bread", "Milk, eggs, coffee"]);
    });

    it("offers three options of EQUAL weight — no default, nothing destructive", () => {
      const el = mount(
        <DevicesDisagree
          choices={choices}
          onChoose={vi.fn<() => void>()}
          subject="Grocery list"
          versions={versions}
        />
      );
      const buttons = [...el.querySelectorAll(".choices button")];
      expect(buttons).toHaveLength(3);
      for (const button of buttons) {
        expect(button.className).toContain("secondary");
        expect(button.className).not.toContain("primary");
        expect(button.className).not.toContain("destructive");
        expect(button.getAttribute("autofocus")).toBeNull();
      }
    });

    it("reports which option was chosen", () => {
      const onChoose = vi.fn<() => void>();
      const el = mount(
        <DevicesDisagree
          choices={choices}
          onChoose={onChoose}
          subject="Grocery list"
          versions={versions}
        />
      );
      act(() =>
        (el.querySelectorAll(".choices button")[2] as HTMLButtonElement).click()
      );
      expect(onChoose).toHaveBeenCalledWith("both");
    });
  });

  describe(OutOfRoom, () => {
    const props = {
      cause: "Your 20 GB backup store is full.",
      consequence: "New photos will stop syncing.",
      fractionUsed: 1,
      limitLabel: "20.0 GB",
      usedLabel: "20.0 GB",
    };

    it("leads with the consequence, and offers exactly ONE action", () => {
      const el = mount(
        <OutOfRoom
          {...props}
          action={{ label: "Free up space", run: vi.fn<() => void>() }}
        />
      );
      expect(el.querySelector(".outOfRoomCause")?.textContent).toBe(
        props.cause
      );
      expect(el.querySelector(".outOfRoomConsequence")?.textContent).toBe(
        props.consequence
      );
      expect(el.querySelector("section")?.getAttribute("aria-labelledby")).toBe(
        "out-of-room-consequence"
      );
      expect(el.querySelectorAll("button")).toHaveLength(1);
    });

    it("takes the danger role only once it is actually over", () => {
      const over = mount(
        <OutOfRoom
          {...props}
          action={{ label: "Free up space", run: vi.fn<() => void>() }}
        />
      ).querySelector(".outOfRoomFill") as HTMLElement;
      expect(over.dataset.over).toBe("true");
      act(() => root?.unmount());
      container?.remove();
      const near = mount(
        <OutOfRoom
          {...props}
          action={{ label: "Free up space", run: vi.fn<() => void>() }}
          fractionUsed={0.9}
        />
      ).querySelector(".outOfRoomFill") as HTMLElement;
      expect(near.dataset.over).toBeUndefined();
      expect(near.style.getPropertyValue("--room-used")).toBe("0.9");
    });

    it("clamps a meter that has run past its own limit", () => {
      const fill = mount(
        <OutOfRoom
          {...props}
          action={{ label: "Free up space", run: vi.fn<() => void>() }}
          fractionUsed={1.4}
        />
      ).querySelector(".outOfRoomFill") as HTMLElement;
      expect(fill.style.getPropertyValue("--room-used")).toBe("1");
    });

    it("runs the one action", () => {
      const run = vi.fn<() => void>();
      const el = mount(
        <OutOfRoom {...props} action={{ label: "Free up space", run }} />
      );
      act(() => (el.querySelector("button") as HTMLButtonElement).click());
      expect(run).toHaveBeenCalledOnce();
    });
  });
});
