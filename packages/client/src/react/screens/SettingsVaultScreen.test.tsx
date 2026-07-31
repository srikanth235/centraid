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
});
