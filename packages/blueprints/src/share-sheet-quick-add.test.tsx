// @vitest-environment jsdom
// Issue #776 Track B: the web ShareSheet's inline person quick-add. The
// destination roster is a one-shot fetch per open, so the local append IS the
// refresh; and an ambiguous name mints nobody until a second, explicit press
// (#630). Rendered as the real component against a stubbed `window.centraid`,
// the same harness shape `apps/tally/components/GroupManager.test.tsx` uses.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { act, createElement } from "react";
import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the app component behind a file-URL dynamic import. The blueprints
// test program is rooted at src; a static import would pull the served app
// tree into that program and trigger TS6059 (see the other app-render tests).
const SHARE_SHEET_PATH = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/ShareSheet.tsx")
).href;
const importShareSheet = (relativePath: string) => import(relativePath);

interface ShareCall {
  members: Array<{ partyId?: string; vaultId?: string; capability: string }>;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonNamed(
  container: HTMLElement,
  label: string
): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label
  );
}

describe("ShareSheet person quick-add (#776 Track B)", () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLElement | null = null;

  const settle = async (): Promise<void> => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const open = async (centraid: Record<string, unknown>): Promise<void> => {
    const { ShareSheet } = (await importShareSheet(SHARE_SHEET_PATH)) as {
      ShareSheet: ComponentType<Record<string, unknown>>;
    };
    (window as unknown as { centraid: unknown }).centraid = centraid;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ShareSheet, {
          open: true,
          onClose: () => undefined,
          onDone: () => undefined,
          sourceScopeId: "vault-1",
          scopes: [],
          itemType: "docs.folder" as const,
          itemIds: ["folder-1"],
        })
      );
    });
    await settle();
  };

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container = null;
    document.body.replaceChildren();
    (window as unknown as { centraid?: unknown }).centraid = undefined;
  });

  it("adds an unambiguous person on the first press, selects them, and shares to their settled party id", async () => {
    const shareCalls: ShareCall[] = [];
    const quickAddPerson = vi.fn<
      (opts: { name: string }) => Promise<{ partyId: string; label: string }>
    >(() => Promise.resolve({ partyId: "p9", label: "Asha" }));
    await open({
      shareTargets: () =>
        Promise.resolve([
          { partyId: "p1", label: "Sam", vaultId: "vault-sam" },
        ]),
      shareCircles: () => Promise.resolve([]),
      quickAddPerson,
      share: (opts: ShareCall) => {
        shareCalls.push(opts);
        return Promise.resolve({ claims: [] });
      },
    });
    const host = container as HTMLElement;

    const input = host.querySelector(
      'input[placeholder="Name"]'
    ) as HTMLInputElement;
    await act(async () => setInputValue(input, "Asha"));
    await act(async () => {
      buttonNamed(host, "Add person")?.click();
    });
    await settle();

    expect(quickAddPerson).toHaveBeenCalledWith({ name: "Asha" });
    expect(host.textContent).toContain("Asha");
    const checkbox = [...host.querySelectorAll('input[type="checkbox"]')].at(
      -1
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(
      (
        host.querySelector(
          'select[aria-label="Asha capability"]'
        ) as HTMLSelectElement
      ).value
    ).toBe("read");
    expect(
      (host.querySelector('input[placeholder="Name"]') as HTMLInputElement)
        .value
    ).toBe("");

    await act(async () => {
      buttonNamed(host, "Share")?.click();
    });
    await settle();

    expect(shareCalls).toHaveLength(1);
    expect(shareCalls[0]?.members).toStrictEqual([
      { partyId: "p9", capability: "read" },
    ]);
  });

  it("asks before minting a second identity for a name already on the roster", async () => {
    const quickAddPerson = vi.fn<
      (opts: { name: string }) => Promise<{ partyId: string; label: string }>
    >(() => Promise.resolve({ partyId: "p9", label: "asha" }));
    await open({
      shareTargets: () => Promise.resolve([{ partyId: "p1", label: "Asha" }]),
      shareCircles: () => Promise.resolve([]),
      quickAddPerson,
      share: () => Promise.resolve({ claims: [] }),
    });
    const host = container as HTMLElement;

    const input = host.querySelector(
      'input[placeholder="Name"]'
    ) as HTMLInputElement;
    await act(async () => setInputValue(input, "asha"));
    await act(async () => {
      buttonNamed(host, "Add person")?.click();
    });
    await settle();

    expect(quickAddPerson).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Already on your list: Asha");

    await act(async () => {
      buttonNamed(host, "Add anyway")?.click();
    });
    await settle();

    expect(quickAddPerson).toHaveBeenCalledWith({ name: "asha" });
  });

  it("offers no quick-add affordance on a host that cannot mint a person", async () => {
    await open({
      shareTargets: () => Promise.resolve([{ partyId: "p1", label: "Sam" }]),
      shareCircles: () => Promise.resolve([]),
      share: () => Promise.resolve({ claims: [] }),
    });
    const host = container as HTMLElement;

    expect(host.querySelector('input[placeholder="Name"]')).toBeNull();
    expect(buttonNamed(host, "Add person")).toBeUndefined();
    expect(host.textContent).toContain("Sam");
  });

  it("keeps the typed name and shows the refusal when the add fails", async () => {
    await open({
      shareTargets: () => Promise.resolve([{ partyId: "p1", label: "Sam" }]),
      shareCircles: () => Promise.resolve([]),
      quickAddPerson: () =>
        Promise.reject(new Error("Adding a person needs a gateway connection")),
      share: () => Promise.resolve({ claims: [] }),
    });
    const host = container as HTMLElement;

    const input = host.querySelector(
      'input[placeholder="Name"]'
    ) as HTMLInputElement;
    await act(async () => setInputValue(input, "Cara"));
    await act(async () => {
      buttonNamed(host, "Add person")?.click();
    });
    await settle();

    expect(host.textContent).toContain(
      "Adding a person needs a gateway connection"
    );
    expect(
      (host.querySelector('input[placeholder="Name"]') as HTMLInputElement)
        .value
    ).toBe("Cara");
  });

  it("offers the quick-add beside the empty-roster copy that promises it", async () => {
    await open({
      shareTargets: () => Promise.resolve([]),
      shareCircles: () => Promise.resolve([]),
      quickAddPerson: () => Promise.resolve({ partyId: "p9", label: "Asha" }),
      share: () => Promise.resolve({ claims: [] }),
    });
    const host = container as HTMLElement;

    expect(host.textContent).toContain(
      "There is nobody to share with yet — add someone by name below."
    );
    expect(host.querySelector('input[placeholder="Name"]')).not.toBeNull();

    const input = host.querySelector(
      'input[placeholder="Name"]'
    ) as HTMLInputElement;
    await act(async () => setInputValue(input, "Asha"));
    await act(async () => {
      buttonNamed(host, "Add person")?.click();
    });
    await settle();

    expect(host.textContent).toContain("Asha");
    expect(
      (host.querySelector('input[type="checkbox"]') as HTMLInputElement | null)
        ?.checked
    ).toBe(true);
  });
});
