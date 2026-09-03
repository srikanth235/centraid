import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import VaultReachSection from "./VaultReachSection.js";

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

    expect(el.textContent).not.toMatch(/\d+ (?:grants|stores|holders)/u);

    press(el, "Apps and agents holding a store");
    press(el, "Standing grants");
    press(el, "What Centraid reads");
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
    expect(el.querySelectorAll(".row")).toHaveLength(0);
    expect(el.textContent).toContain("Who can reach it");
    const toggle = [...el.querySelectorAll("button")].find(
      (b) => b.textContent === "Show"
    );
    act(() => toggle?.click());
    expect(toggled).toBe(1);
  });
});
