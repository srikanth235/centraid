import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import AllAppsSheet from "./AllAppsSheet.js";
import type { LauncherDestination, ShellPage } from "./launcherModel.js";
import Stem from "./Stem.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

const pins = { approvals: true, assistant: true };

const stemProps = {
  pins,
  onSelect: () => {},
  onSearch: () => {},
  onAllApps: () => {},
};

const labelsOf = (el: HTMLElement): string[] =>
  [...el.querySelectorAll(".launchLabel")].map(
    (n) => n.textContent?.trim() ?? ""
  );

describe("shell/Stem", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  describe(Stem, () => {
    it("holds the mark, Search, and the pinned launcher — and nothing else", () => {
      // #707 invariant 1. The three-zone sidebar's recents ledger, vault
      // identity, gateway alarm, update pill and account row all left; if any
      // of them come back the stem has stopped being the stem.
      const el = render(<Stem {...stemProps} />);
      expect(el.querySelector(".stemMark")).not.toBeNull();
      expect(el.querySelector(".stemSearch")).not.toBeNull();
      expect(labelsOf(el)).toStrictEqual([
        "Home",
        "Assistant",
        "Notifications",
      ]);
      expect(el.textContent).not.toContain("Recents");
      expect(el.textContent).not.toContain("Gateway offline");
    });

    it("names itself for assistive tech without labelling every chip twice", () => {
      const el = render(<Stem {...stemProps} />);
      expect(el.querySelector("nav")?.getAttribute("aria-label")).toBe("Apps");
      // The chips are decoration beside a visible label, so they are hidden
      // rather than given a second name.
      for (const chip of el.querySelectorAll(".launchChip"))
        expect(chip.getAttribute("aria-hidden")).toBe("true");
      expect(el.querySelector(".launchItem")?.hasAttribute("aria-label")).toBe(
        false
      );
    });

    it("marks the current destination with aria-current, not a badge", () => {
      const el = render(<Stem {...stemProps} activePage="assistant" />);
      const active = el.querySelector('.launchItem[data-active="true"]')!;
      expect(active.getAttribute("aria-current")).toBe("page");
      expect(active.textContent).toContain("Assistant");
      // Selection is the label + the bar, never a count or a dot.
      expect(el.textContent).not.toMatch(/\d/u);
    });

    it("keeps the Search control on every host and drops only the hint", () => {
      // The installed PWA cannot claim ⌘K — the browser has it — so the
      // control is the guarantee and the shortcut is the extra.
      const withKey = render(<Stem {...stemProps} />);
      expect(withKey.querySelector(".stemSearchKbd")?.textContent).toBe("⌘K");
      act(() => root?.unmount());
      host?.remove();
      const without = render(<Stem {...stemProps} hasCommandKey={false} />);
      expect(without.querySelector(".stemSearch")).not.toBeNull();
      expect(without.querySelector(".stemSearchKbd")).toBeNull();
    });

    it("selects a destination by handing back the model entry", () => {
      const onSelect = vi.fn<(destination: LauncherDestination) => void>();
      const el = render(<Stem {...stemProps} onSelect={onSelect} />);
      const assistant = [
        ...el.querySelectorAll<HTMLButtonElement>(".launchItem"),
      ].find((b) => b.textContent?.includes("Assistant"))!;
      act(() => assistant.click());
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ id: "assistant" })
      );
    });

    describe("as the compact band", () => {
      it("drops the mark and the Search column — the band is tabs only", () => {
        const el = render(<Stem {...stemProps} compact />);
        expect(el.querySelector(".stemMark")).toBeNull();
        expect(el.querySelector(".stemSearch")).toBeNull();
        expect(el.querySelector(".stemAllApps")).toBeNull();
      });

      it("caps at five tabs and moves the rest behind More", () => {
        const onAllApps = vi.fn<() => void>();
        const el = render(
          <Stem
            {...stemProps}
            compact
            onAllApps={onAllApps}
            pins={{
              approvals: true,
              assistant: true,
              atlas: true,
              automations: true,
              connectors: true,
              discover: true,
            }}
          />
        );
        expect(el.querySelectorAll(".launchItem")).toHaveLength(5);
        expect(labelsOf(el).at(-1)).toBe("More");
        act(() =>
          el.querySelector<HTMLButtonElement>(".launchItem:last-child")?.click()
        );
        expect(onAllApps).toHaveBeenCalledOnce();
      });

      it("uses the short label where a destination declares one", () => {
        const el = render(<Stem {...stemProps} compact />);
        expect(labelsOf(el)).toContain("Alerts");
        expect(labelsOf(el)).not.toContain("Notifications");
      });
    });
  });

  describe(AllAppsSheet, () => {
    const sheetProps = {
      pins,
      onTogglePin: () => {},
      onSelect: () => {},
      onClose: () => {},
    };

    it("lists every destination, pinned or not", () => {
      const el = render(<AllAppsSheet {...sheetProps} />);
      const names = [...el.querySelectorAll(".sheetRowName")].map(
        (n) => n.textContent
      );
      expect(names).toContain("Assistant");
      expect(names).toContain("Connectors");
      expect(names).toContain("Storage");
      expect(names.length).toBeGreaterThan(10);
    });

    it("filters as you type, and says so when nothing matches", () => {
      const el = render(<AllAppsSheet {...sheetProps} />);
      const field = el.querySelector("input")!;
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )!.set!;
        setter.call(field, "zzz");
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(el.querySelector(".sheetEmpty")?.textContent).toBe(
        "No app matches that."
      );
    });

    it("carries pin state on a real switch, and toggles it", () => {
      const onTogglePin = vi.fn<(id: ShellPage) => void>();
      const el = render(
        <AllAppsSheet {...sheetProps} onTogglePin={onTogglePin} />
      );
      const pinned = el.querySelector(
        '[aria-label="Pin Assistant to the launcher"]'
      )!;
      expect(pinned.getAttribute("role")).toBe("switch");
      expect(pinned.getAttribute("aria-checked")).toBe("true");
      const unpinned = el.querySelector<HTMLButtonElement>(
        '[aria-label="Pin Connectors to the launcher"]'
      )!;
      expect(unpinned.getAttribute("aria-checked")).toBe("false");
      act(() => unpinned.click());
      expect(onTogglePin).toHaveBeenCalledWith("connectors");
    });

    it("offers Home no switch — it is in the launcher by law", () => {
      const el = render(<AllAppsSheet {...sheetProps} />);
      expect(
        el.querySelector('[aria-label="Pin Home to the launcher"]')
      ).toBeNull();
      expect(el.querySelector(".sheetRowFixed")?.textContent).toBe("Always");
    });

    it("marks an unpinned row with a lighter NAME, never a dimmed row", () => {
      // Container opacity composites every descendant and invalidates the
      // contrast each token was solved for, so the recessive state has to be
      // an attribute the leaf styles off — not a faded parent.
      const el = render(<AllAppsSheet {...sheetProps} />);
      const rows = [...el.querySelectorAll<HTMLElement>(".sheetRowOpen")];
      const assistant = rows.find((r) => r.textContent?.includes("Assistant"))!;
      const connectors = rows.find((r) =>
        r.textContent?.includes("Connectors")
      )!;
      expect(assistant.dataset.pinned).toBe("true");
      expect(connectors.dataset.pinned).toBeUndefined();
      for (const row of rows) expect(row.style.opacity).toBe("");
    });

    it("dismisses on Escape and on the scrim", () => {
      const onClose = vi.fn<() => void>();
      const el = render(<AllAppsSheet {...sheetProps} onClose={onClose} />);
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      expect(onClose).toHaveBeenCalledOnce();
      act(() => el.querySelector<HTMLButtonElement>(".sheetScrim")?.click());
      expect(onClose).toHaveBeenCalledTimes(2);
    });
  });
});
