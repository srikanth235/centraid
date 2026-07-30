import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { THEME_PRESETS } from "@centraid/design-tokens";

import type { SettingsAppearanceBridgeProps } from "../screen-contracts.js";
import type * as CronTimezoneData from "../shell/routes/settingsCronTimezoneData.js";
import SettingsAppearanceScreen from "./SettingsAppearanceScreen.js";

// The folded-in cron default talks to the gateway; stub it so this stays a
// pure render test (carried over from the deleted SettingsLayoutScreen suite).
vi.mock(import("../shell/routes/settingsCronTimezoneData.js"), () => ({
  loadDefaultCronTimeZone: vi.fn<
    typeof CronTimezoneData.loadDefaultCronTimeZone
  >(async () => ""),
  saveDefaultCronTimeZone: vi.fn<
    typeof CronTimezoneData.saveDefaultCronTimeZone
  >(async () => null),
}));

function makeProps(
  over: Partial<SettingsAppearanceBridgeProps> = {}
): SettingsAppearanceBridgeProps {
  return {
    themeMode: "dark",
    density: "regular",
    cardVariant: "outlined",
    onSetThemeMode: vi.fn<SettingsAppearanceBridgeProps["onSetThemeMode"]>(),
    onSetDensity: vi.fn<SettingsAppearanceBridgeProps["onSetDensity"]>(),
    onSetCards: vi.fn<SettingsAppearanceBridgeProps["onSetCards"]>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** The buttons of one `.seg` group, keyed by their stored value. */
function segment(el: HTMLElement, label: string): Map<string, HTMLElement> {
  const group = el.querySelector(`.seg[aria-label="${label}"]`);
  if (!group) throw new Error(`no segmented control labelled ${label}`);
  return new Map(
    [...group.querySelectorAll("button")].map((b) => [b.dataset.value ?? "", b])
  );
}

function click(el: HTMLElement): void {
  void act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("screens/SettingsAppearanceScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });
  function mount(props: SettingsAppearanceBridgeProps): HTMLDivElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<SettingsAppearanceScreen {...props} />);
    });
    return container;
  }

  describe(SettingsAppearanceScreen, () => {
    it("offers exactly two themes plus a system option, not a preset grid", () => {
      const el = mount(makeProps());
      const seg = segment(el, "Appearance");
      expect([...seg.keys()]).toStrictEqual(["light", "dark", "system"]);
      expect(seg.get("system")?.textContent).toBe("Match system");
      expect(seg.get("dark")?.dataset.active).toBe("true");
      // The twelve-card live-preview grid is gone with the ten extra presets.
      expect(el.querySelectorAll(".themeCard")).toHaveLength(0);
    });

    it("is the theme and nothing else — no accent or tile controls", () => {
      const el = mount(makeProps());
      // Accent swatches and app-tile treatment were cut from the page; their
      // prefs still apply, there is just no control for choosing them.
      expect(el.querySelectorAll(".swatch")).toHaveLength(0);
      expect(el.querySelectorAll(".previewTile")).toHaveLength(0);
      expect(el.querySelector('.seg[aria-label="Treatment"]')).toBeNull();
      // Layout folded in (#608), so Density and Cards are groups here now.
      // The sidebar switch did NOT come with them — the chrome already has a
      // toggle for it.
      expect(
        [...el.querySelectorAll(".groupLabel")].map((n) => n.textContent)
      ).toStrictEqual(["Theme", "Density", "Cards", "Automations"]);
      expect(el.querySelector('[aria-label="Show sidebar"]')).toBeNull();
    });

    it("picks a theme mode, including the standing system position", () => {
      const props = makeProps();
      const el = mount(props);
      const system = segment(el, "Appearance").get("system");
      if (!system) throw new Error("no system position");
      click(system);
      expect(props.onSetThemeMode).toHaveBeenCalledWith("system");
      expect(segment(el, "Appearance").get("system")?.dataset.active).toBe(
        "true"
      );
    });

    it("carries Layout's density and card controls, and drives them", async () => {
      const props = makeProps();
      const el = mount(props);
      await act(async () => {});
      const group = (n: number): HTMLButtonElement[] => [
        ...el.querySelectorAll(".seg")[n]!.querySelectorAll("button"),
      ];
      // Theme, Density, Cards — three segmented groups on one page now.
      expect(el.querySelectorAll(".seg")).toHaveLength(3);
      expect(
        group(1).find((b) => b.textContent === "regular")?.dataset.active
      ).toBe("true");
      click(group(1).find((b) => b.textContent === "compact")!);
      expect(props.onSetDensity).toHaveBeenCalledWith("compact");
      click(group(2).find((b) => b.textContent === "elevated")!);
      expect(props.onSetCards).toHaveBeenCalledWith("elevated");
      expect(
        el.querySelector('[data-testid="settings-default-cron-timezone"]')
      ).toBeTruthy();
    });

    it("offers no surface-temperature control at all", () => {
      // Dark has one ramp, so this row is gone in BOTH themes — the parity
      // that removing it bought (#608). A dark-only knob reappearing here is
      // the regression to catch.
      for (const themeMode of ["dark", "light"] as const) {
        const el = mount(makeProps({ themeMode }));
        expect(
          el.querySelector('[aria-label="Surface temperature"]')
        ).toBeNull();
        expect(el.textContent).not.toContain("temperature");
      }
    });
  });
});
