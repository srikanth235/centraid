import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActiveVaultData } from "../shell/routes/settingsAccountData.js";
import SettingsVaultScreen from "./SettingsVaultScreen.js";

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
    expect(el.textContent).toContain("Leaving");
    expect(el.textContent).toContain("Disconnect from this device");
    const disconnect = button(el, "Disconnect")!;
    act(() => disconnect.click());
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("has no Disconnect at all on the local host", async () => {
    const el = await mount();
    expect(button(el, "Disconnect")).toBeUndefined();
    expect(el.textContent).not.toContain("Disconnect from this device");
  });

  it("keeps disconnecting and erasing visibly separate acts", async () => {
    const el = await mount({
      onDisconnect: vi.fn<() => void>(),
      onDelete: vi.fn<() => void>(),
    });
    expect(button(el, "Disconnect")).toBeDefined();
    expect(button(el, "Erase")).toBeDefined();
    expect(el.textContent).toContain("Leaving");
    expect(el.textContent).toContain("Erase this vault");
  });

  it("never calls the connection a gateway", async () => {
    const el = await mount({ onDisconnect: vi.fn<() => void>() });
    expect(el.textContent?.toLowerCase()).not.toContain("gateway");
  });

  describe("the offline copy", () => {
    const toggle = (el: HTMLElement): HTMLInputElement =>
      el.querySelector('input[type="checkbox"]') as HTMLInputElement;

    it("renders as a real control, not prose", async () => {
      const el = await mount({
        offlineCopy: true,
        onOfflineCopy: async () => true,
      });
      expect(el.textContent).toContain("Copies");
      expect(el.textContent).toContain("Keep an offline copy");
      expect(el.textContent).toContain("Encrypted replica");
      expect(toggle(el).checked).toBe(true);
    });

    it("asks before erasing the local copy, and says what goes", async () => {
      const onOfflineCopy = vi.fn<(next: boolean) => Promise<boolean>>(
        async () => false
      );
      const el = await mount({ offlineCopy: true, onOfflineCopy });
      await act(async () => {
        toggle(el).click();
      });
      expect(onOfflineCopy).not.toHaveBeenCalled();
      expect(el.textContent).toContain("The local copy is erased");
      await act(async () => {
        button(el, "Keep it")?.click();
      });
      expect(onOfflineCopy).not.toHaveBeenCalled();
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
      await act(async () => {
        button(el, "Erase it")?.click();
      });
      expect(onOfflineCopy).toHaveBeenCalledWith(false);
      expect(toggle(el).checked).toBe(false);
    });

    it("a rejected change leaves the switch where it was", async () => {
      const onOfflineCopy = vi.fn<(next: boolean) => Promise<boolean>>(
        async () => true
      );
      const el = await mount({ offlineCopy: true, onOfflineCopy });
      await act(async () => {
        toggle(el).click();
      });
      await act(async () => {
        button(el, "Erase it")?.click();
      });
      expect(onOfflineCopy).toHaveBeenCalledWith(false);
      expect(toggle(el).checked).toBe(true);
    });

    it("is absent when the host does not offer one", async () => {
      const el = await mount({ onDisconnect: vi.fn<() => void>() });
      expect(el.querySelector('input[type="checkbox"]')).toBeNull();
      expect(el.textContent).not.toContain("Keep an offline copy");
    });
  });
});
