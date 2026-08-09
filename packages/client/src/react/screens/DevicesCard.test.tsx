import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CentraidGatewayDevice,
  GatewayOwner,
} from "../../gateway-client.js";
import DevicesCard from "./DevicesCard.js";
import type { DevicesCardProps } from "./DevicesCard.js";

// The card is people-first (#726): every assertion here is about a PERSON —
// their vaults, their devices, and the one removal verb this device-token
// client can offer (revoking hardware; removing a PERSON is host-custody).
// A device with no owner is not a state the roster can hold, so there is no
// "Unassigned" case to test for beyond its absence.

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

/** The shape `readJson` throws for the gateway's last-device refusal. */
const LAST_DEVICE_ERROR = new Error(
  'revoke device: {"error":"last_device_confirmation_required","message":' +
    '"this is the owner\'s last device for \\"Personal\\"; type that name in confirmLastDevice."}'
);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
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

  async function mount(
    props: Partial<DevicesCardProps> & Pick<DevicesCardProps, "loadDevices">
  ) {
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <DevicesCard
          now={NOW}
          onRevokeDevice={() => Promise.resolve({ removed: true })}
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

  describe(DevicesCard, () => {
    it("renders an empty state when no devices are paired", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([]),
      });
      expect(el.textContent).toContain("No devices are paired");
    });

    it("shows the caller's own person and their vaults, never a wire word", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([device({ current: true, label: "This laptop" })]),
        loadOwners: vi
          .fn<NonNullable<DevicesCardProps["loadOwners"]>>()
          .mockResolvedValue([owner()]),
      });
      expect(el.textContent).toContain("Priya");
      expect(el.textContent).toContain("Personal");
      expect(el.textContent).not.toContain("admin");
      expect(el.textContent).not.toContain("Unassigned");
      expect(el.textContent).toContain("1 person · 1 device");
      expect(el.textContent).toContain("You");
    });

    it("offers only the narrow removal verb — there is no Remove <person>", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([device()]),
        loadOwners: vi
          .fn<NonNullable<DevicesCardProps["loadOwners"]>>()
          .mockResolvedValue([owner()]),
      });
      expect(button(el, "Revoke device")).toBeTruthy();
      expect(button(el, "Remove Priya")).toBeUndefined();
    });

    it("renames a device inline without revoking it", async () => {
      const original = device();
      const onRenameDevice = vi
        .fn<NonNullable<DevicesCardProps["onRenameDevice"]>>()
        .mockResolvedValue({ ...original, label: "Kitchen browser" });
      const onRevokeDevice = vi
        .fn<DevicesCardProps["onRevokeDevice"]>()
        .mockResolvedValue({ removed: true });
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([original]),
        onRenameDevice,
        onRevokeDevice,
      });

      await click(
        el.querySelector<HTMLButtonElement>(
          '[aria-label="Rename Priya’s browser"]'
        ) ?? undefined
      );
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
        .fn<DevicesCardProps["onRevokeDevice"]>()
        .mockResolvedValue({ removed: true });
      const onCurrentDeviceRevoked = vi
        .fn<NonNullable<DevicesCardProps["onCurrentDeviceRevoked"]>>()
        .mockResolvedValue(undefined);
      const loadDevices = vi
        .fn<DevicesCardProps["loadDevices"]>()
        .mockResolvedValueOnce([device()])
        .mockResolvedValue([]);
      const el = await mount({
        loadDevices,
        onRevokeDevice,
        onCurrentDeviceRevoked,
      });

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
        .fn<DevicesCardProps["onRevokeDevice"]>()
        .mockResolvedValue({ removed: true });
      const onCurrentDeviceRevoked = vi
        .fn<NonNullable<DevicesCardProps["onCurrentDeviceRevoked"]>>()
        .mockResolvedValue(undefined);
      const loadDevices = vi
        .fn<DevicesCardProps["loadDevices"]>()
        .mockResolvedValueOnce([device({ current: true })])
        .mockResolvedValue([]);
      const el = await mount({
        loadDevices,
        onRevokeDevice,
        onCurrentDeviceRevoked,
      });

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
        .fn<DevicesCardProps["onRevokeDevice"]>()
        .mockRejectedValueOnce(LAST_DEVICE_ERROR)
        .mockResolvedValue({ removed: true });
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValueOnce([device()])
          .mockResolvedValue([]),
        onRevokeDevice,
      });

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

    it("folds revoked devices into a tombstone disclosure and out of the counts", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([
            device(),
            device({
              deviceId: "enr_old",
              label: "Stolen phone",
              revoked: true,
            }),
          ]),
        loadOwners: vi
          .fn<NonNullable<DevicesCardProps["loadOwners"]>>()
          .mockResolvedValue([owner()]),
      });
      expect(el.textContent).toContain("1 person · 1 device");
      const details = el.querySelector("details");
      expect(details?.querySelector("summary")?.textContent).toBe(
        "1 revoked device"
      );
      expect(details?.textContent).toContain("Stolen phone");
      // A tombstone carries no action — it exists so past writes still resolve.
      expect(details?.querySelector("button")).toBeNull();
    });

    it("surfaces a load error", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockRejectedValue(new Error("offline")),
      });
      expect(el.textContent).toContain("Couldn’t list paired devices");
      expect(el.textContent).toContain("offline");
    });

    it("hides the pairing affordance when the host cannot mint tickets", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([device()]),
      });
      expect(button(el, "Pair a device")).toBeUndefined();
    });

    it("opens the self-pair panel when the host can mint tickets", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([device()]),
        onCreateTicket:
          vi.fn<NonNullable<DevicesCardProps["onCreateTicket"]>>(),
      });
      await click(button(el, "Pair a device"));
      expect(el.querySelector('[data-testid="pair-panel"]')).toBeTruthy();
    });

    it("offers Add someone beside Pair a device, opening the forPerson panel (#726 P1)", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([device()]),
        onCreateTicket:
          vi.fn<NonNullable<DevicesCardProps["onCreateTicket"]>>(),
      });
      expect(button(el, "Add someone")).toBeTruthy();

      await click(button(el, "Add someone"));
      expect(el.querySelector('[data-testid="pair-panel"]')).toBeTruthy();
      // The mint form, not the self-pair hint — Add someone needs a name.
      expect(el.querySelector('[data-testid="add-someone-name"]')).toBeTruthy();
      // Only one panel at a time: the other entry point is hidden while open.
      expect(button(el, "Pair a device")).toBeUndefined();
    });

    it("hides Add someone when the host cannot mint tickets", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([device()]),
      });
      expect(button(el, "Add someone")).toBeUndefined();
    });
  });
});
