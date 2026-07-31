import { describe, expect, it } from "vitest";

import type {
  CentraidGatewayDevice,
  GatewayMember,
} from "../../gateway-client.js";
import { groupDevicesByMember, vaultsFromGroups } from "./device-groups.js";

// `member_id` is NOT NULL on every binding (#599), so grouping is total: the
// interesting cases are what happens when the ROSTER is missing, not what
// happens when a device has no person — that state cannot exist.

function device(
  over: Partial<CentraidGatewayDevice> = {}
): CentraidGatewayDevice {
  return {
    deviceId: "enr_1",
    endpointId: "ep_1",
    memberId: "mem_priya",
    memberLabel: "Priya",
    label: "Browser",
    transport: "iroh",
    vaultId: "v1",
    vaultName: "Personal",
    role: "write",
    rememberDevice: true,
    ...over,
  };
}

const roster: GatewayMember[] = [
  {
    memberId: "mem_priya",
    label: "Priya",
    createdAt: "2026-07-01T00:00:00.000Z",
    roles: [{ vaultId: "v1", vaultName: "Personal", role: "admin" }],
    deviceCount: 1,
  },
];

describe(groupDevicesByMember, () => {
  it("reads a person’s access off their bindings when the roster is unavailable", () => {
    const groups = groupDevicesByMember([device()], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Priya");
    expect(groups[0]?.roles).toStrictEqual([
      { vaultId: "v1", vaultName: "Personal", role: "write" },
    ]);
  });

  it("prefers the roster’s authored roles over the inherited ones", () => {
    const groups = groupDevicesByMember([device()], roster);
    expect(groups[0]?.roles[0]?.role).toBe("admin");
  });

  it("splits tombstones out of the live device list", () => {
    const groups = groupDevicesByMember(
      [device(), device({ deviceId: "enr_2", role: "revoked" })],
      roster
    );
    expect(groups[0]?.devices.map((d) => d.deviceId)).toStrictEqual(["enr_1"]);
    expect(groups[0]?.revoked.map((d) => d.deviceId)).toStrictEqual(["enr_2"]);
  });

  it("lists a person with no devices, and sorts the caller first", () => {
    const groups = groupDevicesByMember(
      [device({ memberId: "mem_arun", memberLabel: "Arun", current: true })],
      roster
    );
    expect(groups.map((group) => group.label)).toStrictEqual(["Arun", "Priya"]);
    expect(groups[0]?.isSelf).toBe(true);
    expect(groups[1]?.devices).toStrictEqual([]);
  });

  it("folds a device's per-vault enrollments into one hardware row", () => {
    // The devices route returns a row per (device, vault). Two rows for one
    // browser used to render as two devices — the card counted "4 devices"
    // for two — each with a "Revoke device" button that dropped one vault.
    const groups = groupDevicesByMember(
      [
        device({ deviceId: "enr_shared", vaultId: "v1", vaultName: "Shared" }),
        device({
          deviceId: "enr_personal",
          vaultId: "v2",
          vaultName: "Personal",
          role: "admin",
        }),
      ],
      []
    );
    expect(groups[0]?.devices).toHaveLength(1);
    expect(groups[0]?.devices[0]?.enrollmentIds).toStrictEqual([
      "enr_shared",
      "enr_personal",
    ]);
    expect(groups[0]?.devices[0]?.vaults).toStrictEqual([
      { vaultId: "v1", vaultName: "Shared", role: "write" },
      { vaultId: "v2", vaultName: "Personal", role: "admin" },
    ]);
  });

  it("keeps two distinct endpoints apart when they share a person", () => {
    const groups = groupDevicesByMember(
      [
        device(),
        device({ deviceId: "enr_2", endpointId: "ep_2", label: "Phone" }),
      ],
      []
    );
    expect(groups[0]?.devices.map((d) => d.label)).toStrictEqual([
      "Browser",
      "Phone",
    ]);
  });

  it("collects every vault the caller can see, de-duplicated", () => {
    const groups = groupDevicesByMember(
      [
        device(),
        device({
          deviceId: "enr_2",
          vaultId: "v2",
          vaultName: "Photos",
          role: "read",
        }),
      ],
      []
    );
    expect(vaultsFromGroups(groups)).toStrictEqual([
      { vaultId: "v1", vaultName: "Personal", role: "write" },
      { vaultId: "v2", vaultName: "Photos", role: "read" },
    ]);
  });
});
