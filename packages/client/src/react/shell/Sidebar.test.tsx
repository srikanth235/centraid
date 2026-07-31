import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import Sidebar from "./Sidebar.js";
import type { SidebarProps } from "./Sidebar.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
describe("Sidebar suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const base = {
    onHome: () => {},
    onSettings: () => {},
  };

  describe(Sidebar, () => {
    it('hides "Build new" when onNewApp is omitted (#434 builder off)', () => {
      const el = render(<Sidebar {...base} />);
      expect(el.textContent).not.toContain("Build new");
    });

    it("shows the signed-in person in the foot, with their initials", () => {
      const el = render(<Sidebar {...base} accountName="Ada Lovelace" />);
      const row = el.querySelector(".sbAccount")!;
      expect(row.textContent).toContain("Ada Lovelace");
      expect(row.querySelector(".sbAccountAvatar")?.textContent).toBe("AL");
      // Settings is no longer a nav row of its own — it lives in this menu.
      expect(
        [...el.querySelectorAll(".sbItem")].some((b) =>
          b.textContent?.includes("Settings")
        )
      ).toBe(false);
    });

    it("falls back to a placeholder before the roster has loaded", () => {
      const el = render(<Sidebar {...base} />);
      expect(el.querySelector(".sbAccount")?.textContent).toContain("You");
    });

    it("highlights the active page", () => {
      const el = render(
        <Sidebar {...base} activePage="insights" onInsights={() => {}} />
      );
      const active = el.querySelector('[data-active="true"]');
      expect(active?.textContent).toContain("Analytics");
    });

    it("puts New Chat first (no separate Assistant row) and calls the list Recents", () => {
      const onNewChat = vi.fn<NonNullable<SidebarProps["onNewChat"]>>();
      const el = render(
        <Sidebar
          {...base}
          onNewChat={onNewChat}
          conversations={[
            { id: "c1", title: "Thread one", timeLabel: "1h ago" },
            { id: "c2", title: "Thread two", timeLabel: "2h ago" },
          ]}
        />
      );
      expect(el.textContent).toContain("New Chat");
      expect(el.textContent).toContain("Recents");
      expect(el.textContent).not.toContain("Assistant");
      expect(el.textContent).not.toMatch(/Chats ·/u);
      const newChat = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("New Chat")
      ) as HTMLButtonElement;
      act(() => newChat.click());
      expect(onNewChat).toHaveBeenCalledWith();
    });

    it("orders the column actions → Vault → Recents (#667)", () => {
      const el = render(
        <Sidebar
          {...base}
          onSearch={() => {}}
          onApprovals={() => {}}
          onAutomations={() => {}}
          onConnectors={() => {}}
          onHousehold={() => {}}
          onAtlas={() => {}}
          onInsights={() => {}}
        />
      );
      const labels = [...el.querySelectorAll(".sbItem, .sbSection")].map((n) =>
        n.textContent?.trim()
      );
      expect(labels).toStrictEqual([
        "New Chat",
        "Search⌘K",
        "Home",
        "Notifications",
        "Vault",
        "Automations",
        "Connectors",
        "Devices",
        "Data",
        "Analytics",
        "Recents",
        "No chats yet",
      ]);
    });

    it("renames the vault destinations to what the member finds there (#667)", () => {
      const onHousehold = vi.fn<NonNullable<SidebarProps["onHousehold"]>>();
      const onAtlas = vi.fn<NonNullable<SidebarProps["onAtlas"]>>();
      const onInsights = vi.fn<NonNullable<SidebarProps["onInsights"]>>();
      const el = render(
        <Sidebar
          {...base}
          onHousehold={onHousehold}
          onAtlas={onAtlas}
          onInsights={onInsights}
        />
      );
      // The internal model names never surface in the column.
      expect(el.textContent).not.toContain("Household");
      expect(el.textContent).not.toContain("Vault Atlas");
      expect(el.textContent).not.toContain("Insights");
      const click = (label: string): void => {
        const row = [...el.querySelectorAll(".sbItem")].find(
          (b) => b.textContent?.trim() === label
        ) as HTMLButtonElement;
        act(() => row.click());
      };
      click("Devices");
      click("Data");
      click("Analytics");
      expect(onHousehold).toHaveBeenCalledWith();
      expect(onAtlas).toHaveBeenCalledWith();
      expect(onInsights).toHaveBeenCalledWith();
    });

    it("keeps route highlighting on the internal page key, not the label", () => {
      const el = render(
        <Sidebar {...base} activePage="household" onHousehold={() => {}} />
      );
      expect(el.querySelector('[data-active="true"]')?.textContent).toContain(
        "Devices"
      );
    });

    it("disables a vault row whose handler is missing rather than hiding it", () => {
      const el = render(<Sidebar {...base} />);
      const devices = [...el.querySelectorAll(".sbItem")].find(
        (b) => b.textContent?.trim() === "Devices"
      ) as HTMLButtonElement;
      expect(devices.disabled).toBe(true);
    });

    it("drops Discover, Starred and the Apps section from the column", () => {
      const el = render(<Sidebar {...base} onNewApp={() => {}} />);
      // Discover survives in the ⌘K palette — the rail stays short precisely
      // because the palette is the complete index.
      expect(el.textContent).not.toContain("Discover");
      expect(el.textContent).not.toContain("Starred");
      expect(el.textContent).not.toMatch(/Apps ·/u);
      expect(el.textContent).not.toContain("No apps yet");
    });

    it("labels a conversation row with its vault only when one is recorded (#599)", () => {
      const el = render(
        <Sidebar
          {...base}
          conversations={[
            {
              id: "a",
              title: "Groceries",
              timeLabel: "2m",
              scopeLabel: "Family",
            },
            { id: "b", title: "Taxes", timeLabel: "5m" },
          ]}
        />
      );
      const rows = [...el.querySelectorAll(".sbItem")];
      const shared = rows.find((b) => b.textContent?.includes("Groceries"))!;
      const own = rows.find((b) => b.textContent?.includes("Taxes"))!;
      expect(shared.textContent).toContain("Family · 2m");
      expect(own.textContent).toContain("5m");
      expect(own.textContent).not.toContain("·");
    });

    it("says nothing at all about a healthy gateway (#667)", () => {
      const el = render(
        <Sidebar {...base} gatewayStatus="up" onGateway={() => {}} />
      );
      expect(el.textContent).not.toContain("Gateway");
      expect(el.querySelector(".sbAlarm")).toBeNull();
    });

    it("raises a foot alarm — and only then — when the gateway is down", () => {
      const onGateway = vi.fn<NonNullable<SidebarProps["onGateway"]>>();
      const el = render(
        <Sidebar {...base} gatewayStatus="down" onGateway={onGateway} />
      );
      const alarm = el.querySelector(".sbAlarm") as HTMLButtonElement;
      expect(alarm.textContent).toContain("Gateway offline");
      // The alarm belongs to the pinned foot, below the scroll region, so a
      // long Recents list can never push it out of sight.
      expect(el.querySelector(".sbFoot")?.contains(alarm)).toBe(true);
      act(() => alarm.click());
      expect(onGateway).toHaveBeenCalledWith();
    });

    it("renders Recents inside the scroll zone and the account in the pinned foot", () => {
      const el = render(
        <Sidebar
          {...base}
          accountName="Ada Lovelace"
          conversations={[{ id: "c1", title: "Thread one", timeLabel: "1h" }]}
        />
      );
      const scroll = el.querySelector(".sbScroll")!;
      const recents = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("Thread one")
      )!;
      expect(scroll.contains(recents)).toBe(true);
      expect(
        el.querySelector(".sbFoot")?.contains(el.querySelector(".sbAccount")!)
      ).toBe(true);
      expect(scroll.contains(el.querySelector(".sbAccount")!)).toBe(false);
    });

    it("moves What's new off the column and into the account menu", () => {
      const el = render(<Sidebar {...base} onWhatsNew={() => {}} />);
      expect(
        [...el.querySelectorAll(".sbItem")].some((b) =>
          b.textContent?.includes("What's new")
        )
      ).toBe(false);
    });

    it("disables Search when no handler is provided", () => {
      const el = render(<Sidebar {...base} />);
      const search = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("Search")
      ) as HTMLButtonElement;
      expect(search.disabled).toBe(true);
    });

    it("renders a head slot when provided", () => {
      const el = render(
        <Sidebar {...base} headSlot={<div data-testid="head">P</div>} />
      );
      expect(el.querySelector('[data-testid="head"]')).not.toBeNull();
    });

    it("renders the head slot above Build new — the profile switcher leads the column", () => {
      const el = render(
        <Sidebar
          {...base}
          headSlot={<div data-testid="head">P</div>}
          onNewApp={() => {}}
        />
      );
      const head = el.querySelector('[data-testid="head"]')!;
      const buildNew = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("Build new")
      )!;
      // DOCUMENT_POSITION_FOLLOWING on `head` relative to `buildNew` means head
      // comes first in source order.
      expect(
        head.compareDocumentPosition(buildNew) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("omits the head slot entirely when none is supplied (no vault plane / not yet resolved)", () => {
      const el = render(<Sidebar {...base} />);
      expect(el.querySelector('[data-testid="head"]')).toBeNull();
    });

    it("shows no relaunch pill by default", () => {
      const el = render(<Sidebar {...base} />);
      expect(el.querySelector(".sbUpdate")).toBeNull();
      expect(el.textContent).not.toContain("Relaunch to update");
    });

    it("shows the relaunch pill with the new version and fires the handler", () => {
      const onRelaunchToUpdate =
        vi.fn<NonNullable<SidebarProps["onRelaunchToUpdate"]>>();
      const el = render(
        <Sidebar
          {...base}
          updateVersion="0.2.0"
          onRelaunchToUpdate={onRelaunchToUpdate}
        />
      );
      const pill = el.querySelector(".sbUpdate") as HTMLButtonElement;
      expect(pill.textContent).toContain("Relaunch to update");
      expect(pill.textContent).toContain("v0.2.0");
      act(() => pill.click());
      expect(onRelaunchToUpdate).toHaveBeenCalledOnce();
    });

    it("renders the relaunch pill above the account row, below the stretch spacer", () => {
      const el = render(
        <Sidebar
          {...base}
          accountName="Ada Lovelace"
          updateVersion="0.2.0"
          onRelaunchToUpdate={() => {}}
        />
      );
      const pill = el.querySelector(".sbUpdate")!;
      // Settings moved into the account row's menu (⌘,), so the foot anchor
      // is the person, not a nav item.
      const settings = el.querySelector(".sbAccount")!;
      expect(
        pill.compareDocumentPosition(settings) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });
  });
});
