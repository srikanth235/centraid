import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ShellRoute } from "../../app-shell-context.js";
import ShellApp from "./ShellApp.js";
import type { ShellNav } from "./ShellApp.js";

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

describe("shell/ShellApp", () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  const screenFor = (nav: ShellNav): React.ReactNode => (
    <div data-testid="screen" data-kind={nav.route.kind}>
      <button
        type="button"
        data-testid="go-insights"
        onClick={() => nav.navigate({ kind: "insights" })}
      >
        go
      </button>
    </div>
  );
  const sidebarFor = (): React.ReactNode => <div data-testid="sb">SB</div>;

  describe(ShellApp, () => {
    it("opens on the initial route inside the chrome frame", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector(".window")).not.toBeNull();
      expect(
        el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind
      ).toBe("home");
      expect(el.querySelector('[data-testid="sb"]')).not.toBeNull();
    });

    it("navigates on dispatch and enables Back", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
        />
      );
      act(() =>
        (
          el.querySelector('[data-testid="go-insights"]') as HTMLButtonElement
        ).click()
      );
      expect(
        el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind
      ).toBe("insights");
      const back = el.querySelector('[aria-label="Back"]') as HTMLButtonElement;
      expect(back.disabled).toBe(false);
      act(() => back.click());
      expect(
        el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind
      ).toBe("home");
    });

    it("bypasses the frame for full-bleed routes (app view / builder)", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "app", id: "todos" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector(".window")).toBeNull();
      expect(el.querySelector('[data-testid="sb"]')).toBeNull();
      expect(
        el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind
      ).toBe("app");
    });

    it("respects a controlled sidebarOpen prop", () => {
      let open = true;
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
          sidebarOpen={open}
          onSidebarOpenChange={(v) => {
            open = v;
          }}
        />
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "open"
      );
      const toggle = el.querySelector(
        '.tlSide [aria-label="Hide sidebar"]'
      ) as HTMLButtonElement;
      act(() => toggle.click());
      // Controlled: the parent got the new value but didn't re-render, so the DOM
      // stays until the parent flips the prop — proves ShellApp deferred to it.
      expect(open).toBe(false);
    });

    const fullBleedRoutes: ShellRoute[] = [
      { kind: "app", id: "x" },
      { kind: "builder" },
      { kind: "automation-builder", automationId: "a" },
    ];
    it.each(fullBleedRoutes)("treats %o as full-bleed by default", (r) => {
      const el = render(
        <ShellApp
          initialRoute={r}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector(".window")).toBeNull();
    });
  });

  // Compact form factor (#667): the same sidebar, mounted as an overlay
  // drawer. What changes is BEHAVIOUR — a scrim exists, navigating dismisses,
  // and toggling must not write the desktop preference.
  describe("compact drawer", () => {
    function goCompact(): void {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    }
    afterEach(() => vi.unstubAllGlobals());

    it("starts closed regardless of the docked preference, and opens on toggle", () => {
      goCompact();
      // sidebarOpen=true is the DESKTOP pref; a phone must not open holding a
      // drawer over the page.
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
          sidebarOpen
        />
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "closed"
      );
      expect(el.querySelector(".scrim")).toBeNull();
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[aria-label="Show sidebar"]')
          ?.click()
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "open"
      );
      expect(el.querySelector(".scrim")).not.toBeNull();
    });

    it("never writes the docked preference — a dismiss is not a collapse", () => {
      goCompact();
      const changes: boolean[] = [];
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
          sidebarOpen
          onSidebarOpenChange={(open) => changes.push(open)}
        />
      );
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[aria-label="Show sidebar"]')
          ?.click()
      );
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[aria-label="Close navigation"]')
          ?.click()
      );
      expect(changes).toStrictEqual([]);
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "closed"
      );
    });

    it("dismisses itself when the member picks a destination", () => {
      goCompact();
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
        />
      );
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[aria-label="Show sidebar"]')
          ?.click()
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "open"
      );
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[data-testid="go-insights"]')
          ?.click()
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "closed"
      );
    });

    it("dismisses on a row that opens an overlay instead of navigating", () => {
      goCompact();
      // Search opens the ⌘K palette and stays on the same route, so the
      // route-keyed dismissal cannot see it — the rail would sit over the
      // palette it just opened.
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={() => (
            <button type="button" className="sbItem" data-testid="search">
              Search
            </button>
          )}
          renderScreen={screenFor}
        />
      );
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[aria-label="Show sidebar"]')
          ?.click()
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "open"
      );
      act(() =>
        el.querySelector<HTMLButtonElement>('[data-testid="search"]')?.click()
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "closed"
      );
    });

    it("mounts no scrim when the rail is docked", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderSidebar={sidebarFor}
          renderScreen={screenFor}
          sidebarOpen
        />
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.sidebar).toBe(
        "open"
      );
      expect(el.querySelector(".scrim")).toBeNull();
    });
  });
});
