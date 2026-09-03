import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PhoneBridgeProps, PhoneStatusDTO } from "../screen-contracts.js";
import PhoneScreen from "./PhoneScreen.js";

const statusWithDevice: PhoneStatusDTO = {
  running: true,
  devices: [
    {
      deviceId: "d1",
      name: "Pixel 9",
      platform: "android",
      endpointId: "abcdefghijklmnop",
      addedAt: "2026-07-01T00:00:00.000Z",
    },
  ],
};

const emptyStatus: PhoneStatusDTO = { running: true, devices: [] };

function makeProps(over: Partial<PhoneBridgeProps> = {}): PhoneBridgeProps {
  return {
    loadStatus: vi
      .fn<PhoneBridgeProps["loadStatus"]>()
      .mockResolvedValue(emptyStatus),
    beginPairing: vi
      .fn<PhoneBridgeProps["beginPairing"]>()
      .mockResolvedValue(null),
    revoke: vi.fn<PhoneBridgeProps["revoke"]>().mockResolvedValue(true),
    showToast: vi.fn<NonNullable<PhoneBridgeProps["showToast"]>>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe("screens/PhoneScreen", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });
  async function mount(props: PhoneBridgeProps): Promise<HTMLDivElement> {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(<PhoneScreen {...props} />);
    });
    return container;
  }

  describe(PhoneScreen, () => {
    it("shows the connect CTA + empty state when no phones are paired", async () => {
      const el = await mount(makeProps());
      expect(el.textContent).toContain("Connect a phone");
      expect(el.textContent).toContain("No phones paired yet");
    });

    it("lists paired devices with a revoke button that reloads", async () => {
      const loadStatus = vi
        .fn<PhoneBridgeProps["loadStatus"]>()
        .mockResolvedValue(statusWithDevice);
      const props = makeProps({ loadStatus });
      const el = await mount(props);
      expect(el.textContent).toContain("Pixel 9");
      expect(el.textContent).toContain("android");
      const revokeBtn = el.querySelector(".revokeBtn") as HTMLButtonElement;
      await act(async () =>
        revokeBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(props.revoke).toHaveBeenCalledWith("d1");
      expect(loadStatus).toHaveBeenCalledTimes(2); // initial + after revoke
    });

    it("begins pairing and shows the QR + expiry, then clears on pairing completion", async () => {
      let firePaired: ((name: string) => void) | null = null;
      const beginPairing = vi.fn<PhoneBridgeProps["beginPairing"]>(
        async (onPaired) => {
          firePaired = onPaired;
          return {
            info: { qrDataUrl: "data:image/png;base64,AAAA", expiresAt: 0 },
            cancel: vi.fn<() => void>(),
          };
        }
      );
      const props = makeProps({ beginPairing });
      const el = await mount(props);
      const connect = el.querySelector(".btnPrimary") as HTMLButtonElement;
      await act(async () =>
        connect.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      );
      expect(el.querySelector(".qr")).toBeTruthy();
      expect(el.textContent).toContain("Cancel pairing");
      await act(async () => firePaired?.("Pixel 9"));
      expect(props.showToast).toHaveBeenCalledWith("Paired Pixel 9.");
      expect(el.querySelector(".qr")).toBeNull();
    });

    it("renders the error note when the status cannot be read", async () => {
      const loadStatus = vi
        .fn<PhoneBridgeProps["loadStatus"]>()
        .mockResolvedValue(null);
      const el = await mount(makeProps({ loadStatus }));
      expect(el.textContent).toContain("Could not read the phone link status.");
    });
  });
});
