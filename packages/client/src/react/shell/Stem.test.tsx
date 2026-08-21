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
      // #707 invariant 1. The three-zone sidebar's recents ledger, gateway
      // alarm and update pill all left for good; if any of them come back the
      // stem has stopped being the stem.
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

    it("leads with New chat, above Search, and only on the desktop stem", () => {
      // The assistant has no launcher row (#707 settled it as a pinned app),
      // so the one thing it still needs from the band is the ACT of starting a
      // turn. It sits above Search because it is the only action in a column
      // of places — and the compact band has no room for either.
      const onNewConversation = vi.fn<() => void>();
      const el = render(
        <Stem {...stemProps} onNewConversation={onNewConversation} />
      );
      const button = el.querySelector<HTMLButtonElement>(".stemNew");
      expect(button).not.toBeNull();
      expect(button?.textContent).toContain("New chat");
      // Order is the point: DOCUMENT_POSITION_FOLLOWING means Search comes
      // after it.
      const search = el.querySelector(".stemSearch")!;
      expect(
        button!.compareDocumentPosition(search) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      act(() => button?.click());
      expect(onNewConversation).toHaveBeenCalledOnce();
      // Omitted renders nothing at all rather than a dead control.
      expect(
        render(<Stem {...stemProps} />).querySelector(".stemNew")
      ).toBeNull();
      expect(
        render(
          <Stem {...stemProps} compact onNewConversation={onNewConversation} />
        ).querySelector(".stemNew")
      ).toBeNull();
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

    it("uses the handoff's desktop launcher glyph treatment", () => {
      const desktop = render(<Stem {...stemProps} />);
      const desktopIcon = desktop.querySelector(".launchItem .launchChip svg")!;
      expect(desktopIcon.getAttribute("width")).toBe("17");
      expect(desktopIcon.getAttribute("stroke-width")).toBe("1.6");

      act(() => root?.unmount());
      host?.remove();
      const compact = render(<Stem {...stemProps} compact />);
      const compactIcon = compact.querySelector(".launchItem .launchChip svg")!;
      expect(compactIcon.getAttribute("width")).toBe("18");
      expect(compactIcon.getAttribute("stroke-width")).toBe("1.5");
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

    describe("the head", () => {
      const identity = {
        gateway: "This Mac",
        onActivate: () => {},
        vault: "Srikanth",
      };

      it("names the vault and the gateway holding it, as ONE control", () => {
        const onActivate = vi.fn<(anchor: DOMRect) => void>();
        const el = render(
          <Stem {...stemProps} identity={{ ...identity, onActivate }} />
        );
        const head = el.querySelector<HTMLButtonElement>(".stemIdentity")!;
        expect(head.querySelector(".stemVault")?.textContent).toBe("Srikanth");
        expect(head.querySelector(".stemGateway")?.textContent).toBe(
          "This Mac"
        );
        // A menu control, so it says so — the chevron alone is decoration.
        expect(head.getAttribute("aria-haspopup")).toBe("menu");
        expect(head.getAttribute("aria-expanded")).toBe("false");
        act(() => head.click());
        expect(onActivate).toHaveBeenCalledOnce();
      });

      it("wears the VAULT's mark and hue, not the product's", () => {
        const el = render(
          <Stem
            {...stemProps}
            identity={{ ...identity, color: "#845922", icon: "Folder" }}
          />
        );
        const chip = el.querySelector<HTMLElement>(".stemAvatarChip")!;
        expect(chip.style.getPropertyValue("--chip-hue")).toBe("#845922");
        expect(el.querySelector(".stemMark")).toBeNull();
      });

      it("derives a hue and falls back to a mark a vault has not chosen", () => {
        // A stored icon key the registry does not have renders NOTHING, so it
        // is narrowed rather than cast — an empty chip reads as a broken vault.
        const el = render(
          <Stem {...stemProps} identity={{ ...identity, icon: "NotAnIcon" }} />
        );
        const chip = el.querySelector<HTMLElement>(".stemAvatarChip")!;
        expect(chip.style.getPropertyValue("--chip-hue")).not.toBe("");
        expect(chip.querySelector("svg")).not.toBeNull();
      });

      it("falls back to the bare mark before the scopes resolve", () => {
        // The stem paints on the first frame; a head that waits for a read
        // would make the whole band pop in after it.
        const el = render(<Stem {...stemProps} />);
        expect(el.querySelector(".stemIdentity")).toBeNull();
        expect(el.querySelector(".stemMark")).not.toBeNull();
      });
    });

    describe("the foot", () => {
      const account = { name: "Ada Lovelace", onMenu: () => {} };

      it("stands the member's own name there, as the menu trigger", () => {
        // Settings, Pair device, What's new and Log out live in ITS menu, the
        // way they did before #707 — each is something you do a handful of
        // times, and your own name is what is worth the standing row.
        const onMenu = vi.fn<(anchor: DOMRect) => void>();
        const el = render(
          <Stem {...stemProps} account={{ ...account, onMenu }} />
        );
        const row = el.querySelector<HTMLButtonElement>(".stemAccount")!;
        expect(row.getAttribute("aria-haspopup")).toBe("menu");
        expect(row.getAttribute("aria-label")).toBe(
          "Ada Lovelace. Account menu."
        );
        expect(row.querySelector(".stemAvatar")?.textContent).toBe("AL");
        act(() => row.click());
        expect(onMenu).toHaveBeenCalledOnce();
      });

      it("keeps All apps and the account row on separate selectors", () => {
        // They share one rule and one shape; one click must never be both.
        const onAllApps = vi.fn<() => void>();
        const onMenu = vi.fn<(anchor: DOMRect) => void>();
        const el = render(
          <Stem
            {...stemProps}
            onAllApps={onAllApps}
            account={{ ...account, onMenu }}
          />
        );
        act(() => el.querySelector<HTMLButtonElement>(".stemAllApps")?.click());
        expect(onAllApps).toHaveBeenCalledOnce();
        expect(onMenu).not.toHaveBeenCalled();
      });

      it("renders no account row before the profile resolves", () => {
        const el = render(<Stem {...stemProps} />);
        expect(el.querySelector(".stemAccount")).toBeNull();
        expect(el.querySelector(".stemAllApps")).not.toBeNull();
      });
    });

    describe("the ledger", () => {
      it("carries a route's own list under the launcher, desktop only", () => {
        // #707 gave the assistant its ledger, which put a SECOND sidebar next
        // to this one. One band holds the places you can go.
        const ledger = <div data-testid="ledger">threads</div>;
        const el = render(<Stem {...stemProps} ledger={ledger} />);
        expect(
          el.querySelector('.stemLedger [data-testid="ledger"]')
        ).not.toBeNull();
        act(() => root?.unmount());
        host?.remove();
        // The compact band is a row of tabs with nowhere to put a list.
        const band = render(<Stem {...stemProps} ledger={ledger} compact />);
        expect(band.querySelector(".stemLedger")).toBeNull();
      });
    });

    describe("as the compact band", () => {
      it("drops the mark and the Search column — the band is tabs only", () => {
        const el = render(<Stem {...stemProps} compact />);
        expect(el.querySelector(".stemMark")).toBeNull();
        expect(el.querySelector(".stemSearch")).toBeNull();
        expect(el.querySelector(".stemAllApps")).toBeNull();
      });

      it("caps at five destinations plus standing More", () => {
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
              insights: true,
            }}
          />
        );
        expect(el.querySelectorAll(".launchItem")).toHaveLength(6);
        expect(labelsOf(el).at(-1)).toBe("More");
        act(() =>
          el.querySelector<HTMLButtonElement>(".launchItem:last-child")?.click()
        );
        expect(onAllApps).toHaveBeenCalledOnce();
      });

      it("uses the short label where a destination declares one", () => {
        const el = render(
          <Stem
            {...stemProps}
            compact
            pins={{ approvals: true, atlas: true, insights: true }}
          />
        );
        expect(labelsOf(el)).toContain("Alerts");
        expect(labelsOf(el)).not.toContain("Notifications");
        expect(labelsOf(el)).toStrictEqual([
          "Home",
          "Alerts",
          "Activity",
          "Vault",
          "More",
        ]);
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
      expect(names).toContain("System");
      expect(names).toContain("Vault");
      // Every destination this gateway can OFFER — the sheet is the complete
      // index. It lost a row with v11: Copies merged into Vault, and a second
      // row opening the same surface under a second name would make the index
      // a list of two places that are one.
      expect(names.filter((name) => name === "Vault")).toHaveLength(1);
      expect(names.length).toBeGreaterThan(9);
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
