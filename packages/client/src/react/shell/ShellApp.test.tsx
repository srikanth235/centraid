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
  const stemFor = (): React.ReactNode => <div data-testid="stem">STEM</div>;

  describe(ShellApp, () => {
    it("opens on the initial route inside the chrome frame", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderStem={stemFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector(".window")).not.toBeNull();
      expect(
        el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind
      ).toBe("home");
      expect(el.querySelector('[data-testid="stem"]')).not.toBeNull();
    });

    it("navigates on dispatch and enables Back", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderStem={stemFor}
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
          renderStem={stemFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector(".window")).toBeNull();
      expect(el.querySelector('[data-testid="stem"]')).toBeNull();
      expect(
        el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind
      ).toBe("app");
    });

    it("keeps the pointer companion mounted over a full-bleed route", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "app", id: "todos" }}
          renderStem={stemFor}
          renderScreen={screenFor}
          renderAssistantCompanion={(_nav, companion) => (
            <button
              type="button"
              data-testid="companion"
              data-open={String(companion.open)}
              onClick={() => companion.setOpen(true)}
            >
              Ask
            </button>
          )}
        />
      );
      expect(el.querySelector('[data-testid="companion"]')).not.toBeNull();
      expect(
        el.querySelector<HTMLElement>("[data-surface]")?.dataset.surface
      ).toBe("pointer");
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[data-testid="companion"]')
          ?.click()
      );
      expect(
        el.querySelector<HTMLElement>("[data-assistant]")?.dataset.assistant
      ).toBe("open");
    });

    it("mounts the one status line inside the frame", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderStem={stemFor}
          renderScreen={screenFor}
          statusLine={<div data-testid="status">Synced</div>}
        />
      );
      expect(el.querySelector('[data-testid="status"]')).not.toBeNull();
    });

    const fullBleedRoutes: ShellRoute[] = [
      { kind: "app", id: "x" },
      { kind: "automation-builder", automationId: "a" },
    ];
    it.each(fullBleedRoutes)("treats %o as full-bleed by default", (r) => {
      const el = render(
        <ShellApp
          initialRoute={r}
          renderStem={stemFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector(".window")).toBeNull();
    });
  });

  describe("compact band", () => {
    function goCompact(): void {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
    }
    afterEach(() => vi.unstubAllGlobals());

    it("keeps the stem mounted and marks the frame compact", () => {
      goCompact();
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderStem={stemFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector<HTMLElement>(".window")?.dataset.compact).toBe(
        "true"
      );
      expect(el.querySelector('[data-testid="stem"]')).not.toBeNull();
    });

    it("mounts no scrim over the page — the band is not an overlay", () => {
      goCompact();
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderStem={stemFor}
          renderScreen={screenFor}
        />
      );
      expect(el.querySelector(".scrim")).toBeNull();
      expect(el.querySelector('[aria-label="Close navigation"]')).toBeNull();
    });

    it("survives navigation — nothing dismisses the band", () => {
      goCompact();
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderStem={stemFor}
          renderScreen={screenFor}
        />
      );
      act(() =>
        el
          .querySelector<HTMLButtonElement>('[data-testid="go-insights"]')
          ?.click()
      );
      expect(
        el.querySelector<HTMLElement>('[data-testid="screen"]')?.dataset.kind
      ).toBe("insights");
      expect(el.querySelector('[data-testid="stem"]')).not.toBeNull();
    });

    it("keeps the frame uncompact above the breakpoint", () => {
      const el = render(
        <ShellApp
          initialRoute={{ kind: "home" }}
          renderStem={stemFor}
          renderScreen={screenFor}
        />
      );
      expect(
        el.querySelector<HTMLElement>(".window")?.dataset.compact
      ).toBeUndefined();
    });

    it("hands compact full-bleed Assistant state to the route-owned app bar", () => {
      goCompact();
      const el = render(
        <ShellApp
          initialRoute={{ kind: "automation-builder", automationId: "a" }}
          renderStem={stemFor}
          renderScreen={(nav) => {
            const handleToggleAssistant = nav.toggleAssistant;
            return (
              <button
                type="button"
                data-testid="route-assistant"
                aria-label={
                  nav.assistantOpen ? "Close Assistant" : "Open Assistant"
                }
                onClick={handleToggleAssistant}
              >
                Assistant
              </button>
            );
          }}
          renderAssistantCompanion={(_nav, companion) => (
            <div data-testid="companion" data-open={String(companion.open)} />
          )}
        />
      );
      expect(el.querySelector(".touchAssistantDoor")).toBeNull();
      const appBarButton = el.querySelector<HTMLButtonElement>(
        '[data-testid="route-assistant"]'
      );
      expect(appBarButton?.getAttribute("aria-label")).toBe("Open Assistant");
      act(() => appBarButton?.click());
      expect(
        el.querySelector<HTMLElement>('[data-testid="companion"]')?.dataset.open
      ).toBe("true");
      expect(
        el
          .querySelector('[data-testid="route-assistant"]')
          ?.getAttribute("aria-label")
      ).toBe("Close Assistant");
    });
  });
});
