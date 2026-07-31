import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsDeviceScreen from "./SettingsDeviceScreen.js";

// Settings → This device is where the offline copy is decided now: pairing
// stopped asking, so a switch that does not reach the host would silently
// strand the user with whatever the default gave them.

let host: HTMLDivElement;
let root: Root;

function toggle(): HTMLInputElement {
  return host.querySelector('input[type="checkbox"]') as HTMLInputElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("screens/SettingsDeviceScreen", () => {
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  describe(SettingsDeviceScreen, () => {
    it("renders the offline copy as a real control, not prose", async () => {
      await act(async () => {
        root.render(
          <SettingsDeviceScreen
            gatewayLabel="Home gateway"
            offlineCopy
            onOfflineCopy={async () => true}
            onForget={() => undefined}
          />
        );
      });
      expect(toggle().checked).toBe(true);
      expect(host.textContent).toContain("Keep an offline copy");
      expect(host.textContent).toContain("encrypted replica");
    });

    it("flipping it off calls the host setter and shows what took effect", async () => {
      const onOfflineCopy = vi.fn<(next: boolean) => Promise<boolean>>(
        async () => false
      );
      await act(async () => {
        root.render(
          <SettingsDeviceScreen
            gatewayLabel="Home gateway"
            offlineCopy
            onOfflineCopy={onOfflineCopy}
            onForget={() => undefined}
          />
        );
      });
      await click(toggle());
      expect(onOfflineCopy).toHaveBeenCalledWith(false);
      expect(toggle().checked).toBe(false);
    });

    // The switch reports the DEVICE's state, never the user's intent: a
    // refused or failed write must leave it where it was.
    it("a rejected change leaves the switch where it was", async () => {
      const onOfflineCopy = vi.fn<(next: boolean) => Promise<boolean>>(
        async () => true
      );
      await act(async () => {
        root.render(
          <SettingsDeviceScreen
            gatewayLabel="Home gateway"
            offlineCopy
            onOfflineCopy={onOfflineCopy}
            onForget={() => undefined}
          />
        );
      });
      await click(toggle());
      expect(onOfflineCopy).toHaveBeenCalledWith(false);
      expect(toggle().checked).toBe(true);
    });
  });
});
