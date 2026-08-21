import { act, useState } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CentraidGatewayDevice,
  GatewayOwner,
} from "../../gateway-client.js";
import DevicesCard, { useDeviceRoster } from "./DevicesCard.js";
import type { DeviceRosterWiring, DevicesCardProps } from "./DevicesCard.js";

// The roster is people-first (#726) and, since #765, block-shaped: "Yours" is
// a section head over a row block, and everything a device answers to lives in
// the row's own detail behind one trailing verb. Every assertion here is about
// what the reader can DO — open a device, rename it, revoke it — never about
// which class drew it.
//
// Pairing is deliberately NOT a button in here any more: "Pair a device" is
// the page's one filled commit and it lives in the app bar, so the panel is
// opened through the controlled `pairing` prop the screen owns.

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

/** The shape `readJson` throws for the gateway's last-device refusal. */
const LAST_DEVICE_ERROR = new Error(
  'revoke device: {"error":"last_device_confirmation_required","message":' +
    '"this is the owner\'s last device for \\"Personal\\"; type that name in confirmLastDevice."}'
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

type HarnessProps = DeviceRosterWiring &
  Pick<DevicesCardProps, "onCreateTicket">;

/** Mounts the card over its own hook, the way the screen does. The extra
 *  button stands in for the app bar's commit, which is not part of this unit. */
function Harness(props: HarnessProps): JSX.Element {
  const { onCreateTicket, ...wiring } = props;
  const roster = useDeviceRoster(wiring);
  const [pairing, setPairing] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setPairing(true)}>
        Pair a device
      </button>
      <DevicesCard
        now={NOW}
        onPairingChange={setPairing}
        pairing={pairing}
        roster={roster}
        {...(onCreateTicket ? { onCreateTicket } : {})}
      />
    </>
  );
}

describe("DevicesCard suite", () => {
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.clearAllMocks();
  });

  function device(
    over: Partial<CentraidGatewayDevice> = {}
  ): CentraidGatewayDevice {
    return {
      deviceId: "enr_1",
      endpointId: "http:abc",
      ownerId: "o_priya",
      ownerLabel: "Priya",
      label: "Priya’s browser",
      platform: "web",
      transport: "iroh",
      vaultId: "v1",
      vaultName: "Personal",
      addedAt: new Date(NOW - 86_400_000).toISOString(),
      lastUsedAt: new Date(NOW - 3_600_000).toISOString(),
      revoked: false,
      rememberDevice: true,
      ...over,
    };
  }

  function owner(over: Partial<GatewayOwner> = {}): GatewayOwner {
    return {
      ownerId: "o_priya",
      label: "Priya",
      createdAt: new Date(NOW - 86_400_000).toISOString(),
      vaults: [{ vaultId: "v1", vaultName: "Personal" }],
      deviceCount: 1,
      ...over,
    };
  }

  async function mount(props: Partial<HarnessProps> = {}) {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <Harness
          loadDevices={async () => [device()]}
          onRevokeDevice={async () => ({ removed: true })}
          {...props}
        />
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  function button(
    el: HTMLElement,
    text: string
  ): HTMLButtonElement | undefined {
    return [...el.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text
    );
  }

  async function click(el: HTMLButtonElement | undefined): Promise<void> {
    await act(async () => {
      el!.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  /** Open a device's detail — the one verb a row offers. */
  async function open(el: HTMLElement): Promise<void> {
    await click(button(el, "Manage") ?? button(el, "Rename"));
  }

  describe(DevicesCard, () => {
    it("heads your own hardware, and says how much of it there is", async () => {
      const el = await mount({
        loadDevices: async () => [
          device({ current: true, label: "This laptop" }),
        ],
        loadOwners: async () => [owner()],
      });
      const text = el.textContent ?? "";
      expect(text).toContain("Yours");
      expect(text).toContain("This laptop");
      // The row's own state word, not a chip and not a wire word.
      expect(text).toContain("This device");
      expect(text).not.toContain("admin");
      expect(text).not.toContain("Unassigned");
    });

    it("names the person only on someone else's device, and states the rule", async () => {
      const el = await mount({
        loadDevices: async () => [
          device({ current: true }),
          device({
            deviceId: "enr_2",
            endpointId: "http:def",
            label: "Sam’s phone",
            ownerId: "o_sam",
            ownerLabel: "Sam",
          }),
        ],
      });
      const text = el.textContent ?? "";
      expect(text).toContain("Other people");
      expect(text).toContain("Sam’s phone");
      expect(text).toContain("Sam");
      expect(text).toContain("Other person");
      expect(text).toContain(
        "A person on your vault host reaches only what you placed in a shared space."
      );
    });

    it("offers only the narrow removal verb — there is no Remove <person>", async () => {
      const el = await mount({ loadOwners: async () => [owner()] });
      await open(el);
      expect(button(el, "Revoke device")).toBeTruthy();
      expect(button(el, "Remove Priya")).toBeUndefined();
      // Which vaults the hardware reaches is the row's own detail, not a
      // second line on every row in the block.
      expect(el.textContent).toContain("Personal");
    });

    it("renames a device from its own detail, without revoking it", async () => {
      const original = device();
      const onRenameDevice = vi
        .fn<NonNullable<DeviceRosterWiring["onRenameDevice"]>>()
        .mockResolvedValue({ ...original, label: "Kitchen browser" });
      const onRevokeDevice = vi
        .fn<DeviceRosterWiring["onRevokeDevice"]>()
        .mockResolvedValue({ removed: true });
      const el = await mount({
        loadDevices: async () => [original],
        onRenameDevice,
        onRevokeDevice,
      });

      await open(el);
      const input = el.querySelector<HTMLInputElement>(
        'input[aria-label="Device name"]'
      )!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(input, "Kitchen browser");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await click(button(el, "Save"));

      expect(onRenameDevice).toHaveBeenCalledWith("enr_1", "Kitchen browser");
      expect(onRevokeDevice).not.toHaveBeenCalled();
      expect(el.textContent).toContain("Kitchen browser");
    });

    it("requires a confirm step before revoking one device, then calls onRevokeDevice", async () => {
      const onRevokeDevice = vi
        .fn<DeviceRosterWiring["onRevokeDevice"]>()
        .mockResolvedValue({ removed: true });
      const onCurrentDeviceRevoked = vi
        .fn<NonNullable<DeviceRosterWiring["onCurrentDeviceRevoked"]>>()
        .mockResolvedValue(undefined);
      const loadDevices = vi
        .fn<DeviceRosterWiring["loadDevices"]>()
        .mockResolvedValueOnce([device()])
        .mockResolvedValue([]);
      const el = await mount({
        loadDevices,
        onCurrentDeviceRevoked,
        onRevokeDevice,
      });

      await open(el);
      await click(button(el, "Revoke device"));
      expect(onRevokeDevice).not.toHaveBeenCalled();
      expect(el.textContent).toContain("Revoke this device?");

      await click(button(el, "Revoke"));
      expect(onRevokeDevice).toHaveBeenCalledWith("enr_1", undefined);
      expect(onCurrentDeviceRevoked).not.toHaveBeenCalled();
      expect(el.textContent).not.toContain("Priya’s browser");
    });

    it("eagerly purges only after the current device was revoked successfully", async () => {
      const onRevokeDevice = vi
        .fn<DeviceRosterWiring["onRevokeDevice"]>()
        .mockResolvedValue({ removed: true });
      const onCurrentDeviceRevoked = vi
        .fn<NonNullable<DeviceRosterWiring["onCurrentDeviceRevoked"]>>()
        .mockResolvedValue(undefined);
      const el = await mount({
        loadDevices: vi
          .fn<DeviceRosterWiring["loadDevices"]>()
          .mockResolvedValueOnce([device({ current: true })])
          .mockResolvedValue([]),
        onCurrentDeviceRevoked,
        onRevokeDevice,
      });

      await open(el);
      await click(button(el, "Revoke device"));
      await click(button(el, "Revoke"));

      expect(onRevokeDevice).toHaveBeenCalledWith("enr_1", undefined);
      expect(onCurrentDeviceRevoked).toHaveBeenCalledOnce();
      expect(onRevokeDevice.mock.invocationCallOrder[0]!).toBeLessThan(
        onCurrentDeviceRevoked.mock.invocationCallOrder[0]!
      );
    });

    it("escalates the confirm and re-sends confirmLastDevice when the gateway refuses", async () => {
      const onRevokeDevice = vi
        .fn<DeviceRosterWiring["onRevokeDevice"]>()
        .mockRejectedValueOnce(LAST_DEVICE_ERROR)
        .mockResolvedValue({ removed: true });
      const el = await mount({
        loadDevices: vi
          .fn<DeviceRosterWiring["loadDevices"]>()
          .mockResolvedValueOnce([device()])
          .mockResolvedValue([]),
        onRevokeDevice,
      });

      await open(el);
      await click(button(el, "Revoke device"));
      await click(button(el, "Revoke"));
      // The refusal names the vault that would be stranded; the owner is told
      // what recovery costs rather than made to retype a name.
      expect(el.textContent).toContain("last owner device for Personal");

      await click(button(el, "Revoke anyway"));
      expect(onRevokeDevice).toHaveBeenLastCalledWith("enr_1", {
        confirmLastDevice: "Personal",
      });
    });

    it("keeps a revoked device visible, inert, and out of the count", async () => {
      const el = await mount({
        loadDevices: async () => [
          device(),
          device({
            deviceId: "enr_old",
            endpointId: "http:old",
            label: "Stolen phone",
            revoked: true,
          }),
        ],
        loadOwners: async () => [owner()],
      });
      const text = el.textContent ?? "";
      expect(text).toContain("Stolen phone");
      expect(text).toContain("Revoked");
      // One LIVE device — the tombstone is present for audit and counted
      // nowhere.
      expect(el.querySelector("h2")?.nextElementSibling?.textContent).toBe("1");
      // A tombstone carries no action at all.
      expect(button(el, "Manage")).toBeTruthy();
      expect([...el.querySelectorAll("button")]).toHaveLength(2);
    });

    it("shows the pairing panel only when the screen asks for one", async () => {
      const el = await mount({
        onCreateTicket:
          vi.fn<NonNullable<DevicesCardProps["onCreateTicket"]>>(),
      });
      expect(el.querySelector('[data-testid="pair-panel"]')).toBeNull();
      await click(button(el, "Pair a device"));
      expect(el.querySelector('[data-testid="pair-panel"]')).toBeTruthy();
    });

    it("offers Add someone as the quiet second door, opening the forPerson panel (#726 P1)", async () => {
      const el = await mount({
        onCreateTicket:
          vi.fn<NonNullable<DevicesCardProps["onCreateTicket"]>>(),
      });
      await click(button(el, "Add someone"));
      expect(el.querySelector('[data-testid="pair-panel"]')).toBeTruthy();
      // The mint form, not the self-pair hint — Add someone needs a name.
      expect(el.querySelector('[data-testid="add-someone-name"]')).toBeTruthy();
      // Only one door at a time while a panel is open.
      expect(button(el, "Add someone")).toBeUndefined();
    });

    it("hides both pairing doors when the host cannot mint tickets", async () => {
      const el = await mount();
      expect(button(el, "Add someone")).toBeUndefined();
      await click(button(el, "Pair a device"));
      expect(el.querySelector('[data-testid="pair-panel"]')).toBeNull();
    });

    it("reports the work a contributing device could pick up", async () => {
      const el = await mount({
        loadWorkStatus: async () => [
          { vaultId: "v1", total: 5, available: 3, leased: 2 },
        ],
      });
      expect(
        el.querySelector('[data-testid="device-work-depth"]')?.textContent
      ).toContain("3 queued · 2 leased");
    });
  });
});
