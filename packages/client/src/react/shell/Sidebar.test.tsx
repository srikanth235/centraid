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
      const el = render(<Sidebar {...base} activePage="insights" />);
      const active = el.querySelector('[data-active="true"]');
      expect(active?.textContent).toContain("Insights");
    });

    it("puts New Chat first (no separate Assistant row) and renames Chats to History", () => {
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
      expect(el.textContent).toContain("History");
      expect(el.textContent).not.toContain("Assistant");
      expect(el.textContent).not.toMatch(/Chats ·/u);
      const newChat = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("New Chat")
      ) as HTMLButtonElement;
      act(() => newChat.click());
      expect(onNewChat).toHaveBeenCalledWith();
    });

    it("places Automations and Connectors above Pages and fires onConnectors", () => {
      const onConnectors = vi.fn<NonNullable<SidebarProps["onConnectors"]>>();
      const el = render(
        <Sidebar
          {...base}
          activePage="connectors"
          onAutomations={() => {}}
          onConnectors={onConnectors}
        />
      );
      const items = [...el.querySelectorAll(".sbItem")];
      const automations = items.find((b) =>
        b.textContent?.includes("Automations")
      )!;
      const connectors = items.find((b) =>
        b.textContent?.includes("Connectors")
      )!;
      const pagesSection = [...el.querySelectorAll(".sbSection")].find((s) =>
        s.textContent?.includes("Pages")
      )!;
      expect(automations).toBeDefined();
      expect(connectors).toBeDefined();
      expect(pagesSection).toBeDefined();
      expect(
        automations.compareDocumentPosition(connectors) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        connectors.compareDocumentPosition(pagesSection) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      act(() => (connectors as HTMLButtonElement).click());
      expect(onConnectors).toHaveBeenCalledWith();
      expect(el.querySelector('[data-active="true"]')?.textContent).toContain(
        "Connectors"
      );
    });

    it("shows Discover under Pages and omits Starred and the Apps section", () => {
      const onDiscover = vi.fn<NonNullable<SidebarProps["onDiscover"]>>();
      const el = render(
        <Sidebar
          {...base}
          onNewApp={() => {}}
          onDiscover={onDiscover}
          activePage="discover"
        />
      );
      expect(el.textContent).toContain("Discover");
      expect(el.textContent).not.toContain("Starred");
      expect(el.textContent).not.toMatch(/Apps ·/u);
      expect(el.textContent).not.toContain("No apps yet");
      const discover = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("Discover")
      ) as HTMLButtonElement;
      act(() => discover.click());
      expect(onDiscover).toHaveBeenCalledWith();
      expect(el.querySelector('[data-active="true"]')?.textContent).toContain(
        "Discover"
      );
    });

    it("groups the three operations destinations together", () => {
      const el = render(<Sidebar {...base} onGateway={() => {}} />);
      // Sentence case in the markup — chrome.module.css uppercases it.
      const section = [...el.querySelectorAll(".sbSection")].find((s) =>
        s.textContent?.includes("Operations")
      );
      expect(section).toBeDefined();
      expect(section!.textContent).toContain("Operations");

      const items = [...el.querySelectorAll(".sbItem")];
      const gateway = items.find((b) => b.textContent?.includes("Gateway"))!;
      const household = items.find((b) =>
        b.textContent?.includes("Household")
      )!;
      const atlas = items.find((b) => b.textContent?.includes("Vault Atlas"))!;
      expect(gateway).toBeDefined();
      expect(household).toBeDefined();
      expect(atlas).toBeDefined();
      expect(
        items.find((b) => b.textContent?.includes("Storage"))
      ).toBeUndefined();
      expect(
        section!.compareDocumentPosition(gateway) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        gateway.compareDocumentPosition(household) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it("puts Household after Gateway in Operations (#599)", () => {
      const onHousehold = vi.fn<NonNullable<SidebarProps["onHousehold"]>>();
      const el = render(
        <Sidebar {...base} onGateway={() => {}} onHousehold={onHousehold} />
      );
      const items = [...el.querySelectorAll(".sbItem")];
      const gateway = items.find((b) => b.textContent?.includes("Gateway"))!;
      const household = items.find((b) =>
        b.textContent?.includes("Household")
      )!;
      expect(household).toBeDefined();
      expect(
        gateway.compareDocumentPosition(household) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      act(() => (household as HTMLButtonElement).click());
      expect(onHousehold).toHaveBeenCalledWith();
    });

    it("highlights Household on its own route and disables it without a handler", () => {
      const active = render(
        <Sidebar {...base} activePage="household" onHousehold={() => {}} />
      );
      expect(
        active.querySelector('[data-active="true"]')?.textContent
      ).toContain("Household");
      act(() => root?.unmount());
      host?.remove();
      const el = render(<Sidebar {...base} />);
      const household = [...el.querySelectorAll(".sbItem")].find((b) =>
        b.textContent?.includes("Household")
      ) as HTMLButtonElement;
      expect(household.disabled).toBe(true);
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

    it("keeps the Gateway heartbeat pill on Gateway", () => {
      const el = render(
        <Sidebar {...base} gatewayStatus="up" onGateway={() => {}} />
      );
      const items = [...el.querySelectorAll(".sbItem")];
      expect(
        items.find((b) => b.textContent?.includes("Storage"))
      ).toBeUndefined();
      const gateway = items.find((b) => b.textContent?.includes("Gateway"))!;
      expect(gateway.querySelector('[data-tone="live"]')).not.toBeNull();
      expect(gateway.textContent).toContain("up");
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
