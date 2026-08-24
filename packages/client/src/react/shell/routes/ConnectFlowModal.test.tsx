import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import ConnectFlowModal from "./ConnectFlowModal.js";

vi.mock(import("../../../gateway-client.js"), () => ({
  listVaults: async () => [],
}));

// Adding a vault must BE the onboarding ticket step, not a lookalike: the
// modal must not open on a one-card "Existing gateway" chooser while
// onboarding opens straight on the ticket field.

let host: HTMLDivElement;
let root: Root;

describe("shell/routes/ConnectFlowModal", () => {
  beforeEach(() => {
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      testGatewayConnection: vi.fn<() => Promise<unknown>>(),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root.render(
        <ConnectFlowModal
          context="switcher"
          onCancel={() => undefined}
          onDone={() => undefined}
        />
      );
    });
  }

  describe(ConnectFlowModal, () => {
    it("is titled for the vault, not the gateway hosting it", async () => {
      await mount();
      expect(host.querySelector("h2")?.textContent).toBe("Add vault");
    });

    it("opens on the same ticket step onboarding shows — no chooser", async () => {
      await mount();
      expect(host.querySelector("textarea")).toBeTruthy();
      expect(host.textContent).toContain("pairing ticket");
      expect(host.textContent).not.toContain("Existing vault");
      expect(host.textContent).not.toContain("This Mac");
    });

    it("does not ask about an offline copy", async () => {
      await mount();
      expect(host.querySelector('input[type="checkbox"]')).toBeNull();
    });
  });
});
