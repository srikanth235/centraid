import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import VaultReachSection from "./VaultReachSection.js";

// "Who can reach it" (v11) — the section whose entire job is to NOT restate
// anything. Every test here is about a copy that must not appear.

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(
  props: Parameters<typeof VaultReachSection>[0]
): HTMLDivElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<VaultReachSection {...props} />));
  return host;
}

const press = (el: HTMLElement, name: string): void => {
  const row = [...el.querySelectorAll<HTMLElement>(".row")].find((r) =>
    r.textContent?.includes(name)
  );
  act(() => row?.querySelector("button")?.click());
};

describe(VaultReachSection, () => {
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
  });

  it("points at where consent is answered, and copies none of it", () => {
    // The OUTCOME each row produces is a navigation, so the test records the
    // navigations rather than asserting that a mock ran.
    const went: string[] = [];
    const el = render({
      collapsed: false,
      onOpenApprovals: () => went.push("notifications"),
      onOpenEnrichment: () => went.push("enrichment"),
      onToggle: () => {},
    });
    const rows = [...el.querySelectorAll(".row")];
    expect(rows).toHaveLength(3);
    expect(el.textContent).toContain("Apps and agents holding a store");
    expect(el.textContent).toContain("Standing grants");
    expect(el.textContent).toContain("What Centraid reads");

    // NO COUNTS. A count is a copy — read from one place and drawn in another,
    // and it goes stale exactly as silently as a duplicated list would.
    expect(el.textContent).not.toMatch(/\d+ (?:grants|stores|holders)/u);

    press(el, "Apps and agents holding a store");
    press(el, "Standing grants");
    press(el, "What Centraid reads");
    // Two rows about consent land on Notifications; enrichment is a Settings
    // page, and neither row invents a third place.
    expect(went).toStrictEqual([
      "notifications",
      "notifications",
      "enrichment",
    ]);
  });

  it("says the rule where a member can act on it, in two statements", () => {
    const el = render({
      collapsed: false,
      onOpenApprovals: () => {},
      onOpenEnrichment: () => {},
      onToggle: () => {},
    });
    expect(el.textContent).toContain("Consent is answered where it is asked.");
    expect(el.textContent).toContain("lives in that app’s consent pane");
  });

  it("draws the head and nothing else when it is closed", () => {
    let toggled = 0;
    const el = render({
      collapsed: true,
      onOpenApprovals: () => {},
      onOpenEnrichment: () => {},
      onToggle: () => {
        toggled += 1;
      },
    });
    // Closed means GONE from the DOM, not hidden: rows under `display: none`
    // are still found by find-in-page and still tabbed into.
    expect(el.querySelectorAll(".row")).toHaveLength(0);
    expect(el.textContent).toContain("Who can reach it");
    const toggle = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Show"
    );
    act(() => toggle?.click());
    expect(toggled).toBe(1);
  });
});
