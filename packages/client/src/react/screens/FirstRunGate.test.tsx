import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";

import FirstRunGate from "./FirstRunGate.js";
import type { FirstRunGateProps } from "./FirstRunGate.js";
import type { OnboardingCompleteInput } from "./OnboardingScreen.js";

// FirstRunGate pulls in OnboardingScreen (→ ConnectFlow → gateway-client),
// which reaches gateway-client-core's module-load window.CentraidApi listeners.
// `vi.hoisted` is lifted above the import, so this stub is installed first.
vi.hoisted(() => {
  (window as unknown as { CentraidApi: Record<string, unknown> }).CentraidApi =
    {
      onGatewayChanged: () => () => undefined,
      onVaultChanged: () => () => undefined,
      getGatewayAuth: async () => ({
        baseUrl: "https://gateway.test",
        token: "t",
      }),
    };
});

function makeProps(over: Partial<FirstRunGateProps> = {}): FirstRunGateProps {
  return {
    onOnboardingComplete: vi.fn<(input: OnboardingCompleteInput) => void>(),
    host: "desktop",
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("FirstRunGate scenarios", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  async function flush(times = 3): Promise<void> {
    await forEachSequentially(Array.from({ length: times }), async () => {
      await act(async () => {
        await Promise.resolve();
      });
    });
  }

  async function mount(props: FirstRunGateProps): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<FirstRunGate {...props} />);
    });
    await flush();
    return container;
  }

  function clickIncludes(el: HTMLElement, text: string): void {
    const btn = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(text)
    );
    act(() => btn?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  describe(FirstRunGate, () => {
    it("desktop offers exactly the two first-run choices — and no founding ceremony", async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain("Start fresh on this Mac");
      expect(el.textContent).toContain("Connect with a ticket");
      expect(el.textContent).not.toContain("Create vault");
      expect(el.textContent).not.toContain("Restore vault");
      expect(el.querySelectorAll("button")).toHaveLength(2);
    });

    it('"Start fresh on this Mac" hands straight to onboarding', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, "Start fresh on this Mac");
      await flush();
      expect(el.querySelector('[data-testid="onboarding-view"]')).toBeTruthy();
      // Never a name question first — that is asked after connecting, and
      // only when the roster has no name for this person.
      expect(el.textContent).not.toContain("Make yourself");
    });

    it('"Connect with a ticket" opens on the pairing step', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, "Connect with a ticket");
      await flush();
      expect(el.textContent).toContain("Connect your");
      expect(el.textContent).not.toContain("Make yourself");
    });

    it('"Start over" from a chosen path returns to the chooser', async () => {
      const el = await mount(makeProps());
      clickIncludes(el, "Connect with a ticket");
      await flush();
      clickIncludes(el, "Start over");
      await flush();
      expect(el.querySelector('[data-testid="first-run-choice"]')).toBeTruthy();
    });

    it("web never shows the chooser — the ticket path is the only path", async () => {
      const el = await mount(makeProps({ host: "web" }));
      expect(el.querySelector('[data-testid="first-run-choice"]')).toBeNull();
      expect(el.textContent).toContain("Connect your");
      expect(el.textContent).not.toContain("this Mac");
      // No chooser to go back to, so neither escape is offered: the flow was
      // opened with a single method, so ConnectFlow's own "Back" (which would
      // land on a one-option chooser) is suppressed too.
      expect(
        [...el.querySelectorAll("button")].some((b) =>
          ["Back", "Start over"].includes(b.textContent ?? "")
        )
      ).toBe(false);
    });
  });
});
