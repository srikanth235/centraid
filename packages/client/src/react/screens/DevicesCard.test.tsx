import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CentraidGatewayDevice,
  GatewayMember,
} from "../../gateway-client.js";
import DevicesCard, { type DevicesCardProps } from "./DevicesCard.js";

// The card is people-first (#599): every assertion here is about a PERSON —
// their access in ownership words, their devices, and the two distinct
// removal verbs. A device with no person is not a state the roster can hold,
// so there is no "Unassigned" case to test for beyond its absence.

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

/** The shape `readJson` throws for the gateway's last-owner refusal. */
const LAST_ADMIN_ERROR = new Error(
  'revoke device: {"error":"last_admin_confirmation_required","message":' +
    '"this is the last admin enrollment; type \\"Personal\\" in confirmLastAdmin."}'
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
      memberId: "mem_priya",
      memberLabel: "Priya",
      label: "Priya’s browser",
      platform: "web",
      transport: "iroh",
      vaultId: "v1",
      vaultName: "Personal",
      addedAt: new Date(NOW - 86_400_000).toISOString(),
      lastUsedAt: new Date(NOW - 3_600_000).toISOString(),
      role: "write",
      rememberDevice: true,
      ...over,
    };
  }

  function member(over: Partial<GatewayMember> = {}): GatewayMember {
    return {
      memberId: "mem_priya",
      label: "Priya",
      createdAt: new Date(NOW - 86_400_000).toISOString(),
      roles: [{ vaultId: "v1", vaultName: "Personal", role: "write" }],
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

    it("groups devices under the person they act as, in ownership words", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([
            device({ current: true, label: "This laptop" }),
            device({
              deviceId: "enr_2",
              memberId: "mem_arun",
              memberLabel: "Arun",
              label: "Old phone",
              platform: "ios",
              role: "read",
            }),
          ]),
        loadMembers: vi
          .fn<NonNullable<DevicesCardProps["loadMembers"]>>()
          .mockResolvedValue([
            member({
              roles: [{ vaultId: "v1", vaultName: "Personal", role: "admin" }],
            }),
            member({
              memberId: "mem_arun",
              label: "Arun",
              roles: [{ vaultId: "v1", vaultName: "Personal", role: "read" }],
            }),
          ]),
      });
      expect(el.textContent).toContain("Priya");
      expect(el.textContent).toContain("Arun");
      // admin/write/read never reach the owner's eyes.
      expect(el.textContent).toContain("Owner · Personal");
      expect(el.textContent).toContain("Viewer · Personal");
      expect(el.textContent).not.toContain("admin");
      expect(el.textContent).not.toContain("Unassigned");
      expect(el.textContent).toContain("2 people · 2 devices");
      // The group holding this device is the caller's, and sorts first.
      expect(el.textContent).toContain("You");
      expect(el.querySelectorAll("h3")[0]?.textContent).toBe("Priya");
    });

    it("offers the two removal verbs as distinct affordances", async () => {
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValue([device()]),
        loadMembers: vi
          .fn<NonNullable<DevicesCardProps["loadMembers"]>>()
          .mockResolvedValue([member()]),
        onRemoveMember: vi
          .fn<NonNullable<DevicesCardProps["onRemoveMember"]>>()
          .mockResolvedValue({ removed: true }),
      });
      expect(button(el, "Revoke device")).toBeTruthy();
      expect(button(el, "Remove Priya")).toBeTruthy();
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

    it("escalates the confirm and re-sends confirmLastAdmin when the gateway refuses", async () => {
      const onRevokeDevice = vi
        .fn<DevicesCardProps["onRevokeDevice"]>()
        .mockRejectedValueOnce(LAST_ADMIN_ERROR)
        .mockResolvedValue({ removed: true });
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValueOnce([device({ role: "admin" })])
          .mockResolvedValue([]),
        onRevokeDevice,
      });

      await click(button(el, "Revoke device"));
      await click(button(el, "Revoke"));
      // The refusal names the space that would be stranded; the owner is told
      // what recovery costs rather than made to retype a name.
      expect(el.textContent).toContain("last owner device for Personal");

      await click(button(el, "Revoke anyway"));
      expect(onRevokeDevice).toHaveBeenLastCalledWith("enr_1", {
        confirmLastAdmin: "Personal",
      });
    });

    it("removes a person with a single confirm", async () => {
      const onRemoveMember = vi
        .fn<NonNullable<DevicesCardProps["onRemoveMember"]>>()
        .mockResolvedValue({ removed: true });
      const el = await mount({
        loadDevices: vi
          .fn<DevicesCardProps["loadDevices"]>()
          .mockResolvedValueOnce([device()])
          .mockResolvedValue([]),
        loadMembers: vi
          .fn<NonNullable<DevicesCardProps["loadMembers"]>>()
          .mockResolvedValueOnce([member()])
          .mockResolvedValue([]),
        onRemoveMember,
      });

      await click(button(el, "Remove Priya"));
      expect(onRemoveMember).not.toHaveBeenCalled();
      expect(el.textContent).toContain("Remove Priya and their 1 device?");

      await click(button(el, "Remove"));
      expect(onRemoveMember).toHaveBeenCalledWith("mem_priya", undefined);
      expect(el.textContent).not.toContain("Priya");
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
              role: "revoked",
            }),
          ]),
        loadMembers: vi
          .fn<NonNullable<DevicesCardProps["loadMembers"]>>()
          .mockResolvedValue([member()]),
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
  });
});
