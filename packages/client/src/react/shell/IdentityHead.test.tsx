import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import IdentityHead from "./IdentityHead.js";

// The sidebar identity row (#599, Decision 14). It names the active vault and
// gateway, and the WHOLE row is the switcher (#608) — Slack's workspace
// header, not a 26px glyph at the right edge. Household moved to its own nav
// entry, and stays the row's behaviour only where no switcher is wired.

let root: Root | null = null;
let host: HTMLElement | null = null;
describe("IdentityHead suite", () => {
  beforeAll(() => {
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({
        background: "#111",
        boxShadow: "none",
        glyphColor: "#fff",
      }),
    };
  });

  function render(el: React.ReactElement): HTMLElement {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(el));
    return host;
  }

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  describe(IdentityHead, () => {
    it("names the member’s own vault and the gateway it lives on", () => {
      const el = render(
        <IdentityHead
          vault={{ name: "Priya", color: "#4E68DD", icon: "Sparkle" }}
          gatewayLabel="This Mac"
          onOpenHousehold={() => {}}
        />
      );
      expect(el.textContent).toContain("Priya");
      expect(el.textContent).toContain("This Mac");
      // Eyebrow-then-name: the gateway is the quiet context line ABOVE the
      // vault, which is the bold selection (the compact-selector idiom).
      expect(el.querySelector(".eyebrow")?.textContent).toBe("This Mac");
      expect(el.querySelector(".name")?.textContent).toBe("Priya");
      const text = el.querySelector(".text")!;
      expect(text.firstElementChild?.className).toContain("eyebrow");
      expect(text.lastElementChild?.className).toContain("name");
    });

    it("shows the up/down stepper only when the row opens a switcher", () => {
      const withSwitcher = render(
        <IdentityHead
          vault={{ name: "Priya" }}
          gatewayLabel="This Mac"
          onOpenHousehold={() => {}}
          onSwitchGateway={() => {}}
        />
      );
      // ⌃ over ⌄ — two chevrons composing one glyph, decoration only.
      const stepper = withSwitcher.querySelector(".stepper")!;
      expect(stepper.getAttribute("aria-hidden")).toBe("true");
      expect(stepper.querySelectorAll("svg")).toHaveLength(2);
      expect(stepper.querySelector(".stepUp")).not.toBeNull();
      act(() => root?.unmount());
      host?.remove();

      const without = render(
        <IdentityHead
          vault={{ name: "Priya" }}
          gatewayLabel="This Mac"
          onOpenHousehold={() => {}}
        />
      );
      expect(without.querySelector(".stepper")).toBeNull();
    });

    it("hides the gateway switch when there is nothing to switch between", () => {
      const el = render(
        <IdentityHead
          vault={{ name: "Priya" }}
          gatewayLabel="This Mac"
          onOpenHousehold={() => {}}
        />
      );
      expect(el.querySelector('[aria-label="Switch gateway"]')).toBeNull();
    });

    it("makes the WHOLE row the switcher, not a glyph at the right edge", () => {
      const onSwitchGateway =
        vi.fn<
          NonNullable<
            React.ComponentProps<typeof IdentityHead>["onSwitchGateway"]
          >
        >();
      const onOpenHousehold = vi.fn<() => void>();
      const el = render(
        <IdentityHead
          vault={{ name: "Priya" }}
          gatewayLabel="Office"
          onOpenHousehold={onOpenHousehold}
          onSwitchGateway={onSwitchGateway}
          switcherOpen
        />
      );
      // Exactly one button — the row itself. The stepper is decoration inside
      // it, so it cannot take hit area away from the name the user aimed at.
      const buttons = el.querySelectorAll("button");
      expect(buttons).toHaveLength(1);
      const row = buttons[0] as HTMLButtonElement;
      expect(row.getAttribute("aria-label")).toBe(
        "Priya on Office. Switch vault or gateway."
      );
      expect(row.getAttribute("aria-haspopup")).toBe("menu");
      expect(row.getAttribute("aria-expanded")).toBe("true");
      act(() => row.click());
      expect(onSwitchGateway).toHaveBeenCalledWith(
        expect.objectContaining({ width: 0, height: 0 })
      );
      // Household is a sidebar nav entry now; the row does not double as one.
      expect(onOpenHousehold).not.toHaveBeenCalled();
    });

    it("falls back to Household when no switcher is wired", () => {
      const onOpenHousehold = vi.fn<() => void>();
      const el = render(
        <IdentityHead
          vault={{ name: "Priya" }}
          gatewayLabel="This Mac"
          onOpenHousehold={onOpenHousehold}
        />
      );
      const row = el.querySelector("button") as HTMLButtonElement;
      expect(row.getAttribute("aria-label")).toContain("Household");
      act(() => row.click());
      expect(onOpenHousehold).toHaveBeenCalledWith();
    });

    it("renders a quiet placeholder, disabled, until the scope registry resolves", () => {
      const el = render(
        <IdentityHead gatewayLabel="—" onOpenHousehold={() => {}} />
      );
      const head = el.querySelector("button") as HTMLButtonElement;
      expect(head.disabled).toBe(true);
      expect(el.textContent).toContain("Loading…");
    });
  });
});
