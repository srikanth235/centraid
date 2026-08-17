import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActiveVaultData } from "../shell/routes/settingsAccountData.js";
import SettingsVaultScreen from "./SettingsVaultScreen.js";

// Settings → Vault is where the owner acts on the vault they are in, including
// the one act that used to live on a "Gateways" page: leaving it behind on this
// device (issue #665). The gate is the CONNECTION being a remote one — the
// primordial local host is this machine, and it has nothing to disconnect from.

const vault = (over: Partial<ActiveVaultData> = {}): ActiveVaultData => ({
  vaultId: "v1",
  name: "Work",
  icon: "Folder",
  color: "#4E68DD",
  blurb: "",
  deletable: true,
  ...over,
});

let root: Root | null = null;
let container: HTMLDivElement | null = null;

describe("screens/SettingsVaultScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  async function mount(
    over: Partial<Parameters<typeof SettingsVaultScreen>[0]> = {}
  ): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <SettingsVaultScreen
          vault={vault()}
          onSave={vi.fn<() => void>()}
          {...over}
        />
      );
    });
    return container as HTMLDivElement;
  }

  const button = (
    el: HTMLElement,
    label: string
  ): HTMLButtonElement | undefined =>
    [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(label)
    );

  it("offers Disconnect for a vault reached over a remote connection", async () => {
    const onDisconnect = vi.fn<() => void>();
    const el = await mount({ onDisconnect });
    expect(el.textContent).toContain("On this device");
    const disconnect = button(el, "Disconnect from this device")!;
    act(() => disconnect.click());
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("has no Disconnect at all on the local host", async () => {
    const el = await mount();
    expect(button(el, "Disconnect from this device")).toBeUndefined();
    expect(el.textContent).not.toContain("On this device");
  });

  it("keeps disconnecting and erasing visibly separate acts", async () => {
    const el = await mount({
      onDisconnect: vi.fn<() => void>(),
      onDelete: vi.fn<() => void>(),
    });
    // Leaving this device is reversible; erasing the vault is not. They must
    // never read as two labels for the same button.
    expect(button(el, "Disconnect from this device")).toBeDefined();
    expect(button(el, "Erase this vault")).toBeDefined();
    expect(el.textContent).toContain("Danger zone");
  });

  it("never calls the connection a gateway", async () => {
    const el = await mount({ onDisconnect: vi.fn<() => void>() });
    expect(el.textContent?.toLowerCase()).not.toContain("gateway");
  });

  // The offline copy moved here when Settings → This device was retired. It is
  // still the whole of the owner's control over the replica — pairing stopped
  // asking — so the three laws that guarded it there guard it here.
  describe("the offline copy", () => {
    const toggle = (el: HTMLElement): HTMLInputElement =>
      el.querySelector('input[type="checkbox"]') as HTMLInputElement;

    it("renders as a real control, not prose", async () => {
      const el = await mount({
        offlineCopy: true,
        onOfflineCopy: async () => true,
      });
      expect(el.textContent).toContain("On this device");
      expect(el.textContent).toContain("Keep an offline copy");
      expect(el.textContent).toContain("encrypted replica");
      expect(toggle(el).checked).toBe(true);
    });

    it("flipping it off calls the host setter and shows what took effect", async () => {
      const onOfflineCopy = vi.fn<(next: boolean) => Promise<boolean>>(
        async () => false
      );
      const el = await mount({ offlineCopy: true, onOfflineCopy });
      await act(async () => {
        toggle(el).click();
      });
      expect(onOfflineCopy).toHaveBeenCalledWith(false);
      expect(toggle(el).checked).toBe(false);
    });

    // The switch reports the DEVICE's state, never the user's intent: a
    // refused or failed write must leave it where it was.
    it("a rejected change leaves the switch where it was", async () => {
      const onOfflineCopy = vi.fn<(next: boolean) => Promise<boolean>>(
        async () => true
      );
      const el = await mount({ offlineCopy: true, onOfflineCopy });
      await act(async () => {
        toggle(el).click();
      });
      expect(onOfflineCopy).toHaveBeenCalledWith(false);
      expect(toggle(el).checked).toBe(true);
    });

    // Desktop runs the gateway in-process: there is no second copy to keep, so
    // the row is absent rather than present-and-inert.
    it("is absent when the host does not offer one", async () => {
      const el = await mount({ onDisconnect: vi.fn<() => void>() });
      expect(el.querySelector('input[type="checkbox"]')).toBeNull();
      expect(el.textContent).not.toContain("Keep an offline copy");
    });
  });
});
