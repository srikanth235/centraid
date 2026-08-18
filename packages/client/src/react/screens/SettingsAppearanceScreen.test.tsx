import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    onSetThemeMode: vi.fn<SettingsAppearanceBridgeProps["onSetThemeMode"]>(),
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

    it("is the theme and nothing else — no accent, tile or card controls", () => {
      const el = mount(makeProps());
      // Accent swatches, app-tile treatment and the card surface were each cut
      // from the page; their prefs still apply, there is just no control for
      // choosing them. The sidebar switch did NOT come with them — the chrome
      // already has a toggle for it.
      expect(el.querySelectorAll(".swatch")).toHaveLength(0);
      expect(el.querySelectorAll(".previewTile")).toHaveLength(0);
      expect(el.querySelector('.seg[aria-label="Treatment"]')).toBeNull();
      expect(el.querySelector('.seg[aria-label="Cards"]')).toBeNull();
      expect(el.textContent).not.toContain("Surface");
      // One section head over both rows (v11): the theme and the automation
      // zone are the same subject — what this device does — and two heads over
      // one control each is a taxonomy the page does not need.
      expect(
        [...el.querySelectorAll(".groupLabel")].map((n) => n.textContent)
      ).toStrictEqual(["This device"]);
      expect(el.textContent).toContain("Time zone for automations");
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

    it("states that Match system is a standing mode, only while it is chosen", () => {
      const props = makeProps();
      const el = mount(props);
      expect(el.textContent).not.toContain("Follows the system as it changes");
      const system = segment(el, "Appearance").get("system");
      if (!system) throw new Error("no system position");
      click(system);
      expect(el.textContent).toContain("Follows the system as it changes");
    });

    it("returns the time zone to the gateway's value and names it when refused", async () => {
      const saved = vi.mocked(
        (await import("../shell/routes/settingsCronTimezoneData.js"))
          .saveDefaultCronTimeZone
      );
      const loaded = vi.mocked(
        (await import("../shell/routes/settingsCronTimezoneData.js"))
          .loadDefaultCronTimeZone
      );
      loaded.mockResolvedValueOnce("Europe/London");
      saved.mockResolvedValueOnce(
        "Not a zone the gateway knows. Still using Europe/London."
      );
      const el = mount(makeProps());
      await act(async () => {});
      const field = el.querySelector<HTMLInputElement>(
        '[data-testid="settings-default-cron-timezone"]'
      );
      if (!field) throw new Error("no time zone field");
      const setValue = Object.getOwnPropertyDescriptor(
        globalThis.HTMLInputElement.prototype,
        "value"
      )?.set;
      await act(async () => {
        setValue?.call(field, "Not/A_Zone");
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("focusout", { bubbles: true }));
      });
      await act(async () => {});
      expect(field.value).toBe("Europe/London");
      expect(el.textContent).toContain("Still using Europe/London.");
    });

    it("leaves the theme as the page's only segmented control", async () => {
      const el = mount(makeProps());
      await act(async () => {});
      expect(el.querySelectorAll(".seg")).toHaveLength(1);
      expect(
        el.querySelector('[data-testid="settings-default-cron-timezone"]')
      ).toBeTruthy();
    });

    // The cron default is a squatter on this page and a gateway-wide AUTOMATION
    // default. On a gateway that runs no automations it is a control whose
    // effect can never be observed, so it is not offered at all — including its
    // suggestion list, which would otherwise be markup nothing can reach.
    it("withholds the cron default when the gateway runs no automations", async () => {
      const el = mount(makeProps({ automations: false }));
      await act(async () => {});
      expect(
        el.querySelector('[data-testid="settings-default-cron-timezone"]')
      ).toBeNull();
      expect(el.querySelector("#centraid-cron-timezones")).toBeNull();
      expect(el.textContent).not.toContain("Time zone for automations");
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
