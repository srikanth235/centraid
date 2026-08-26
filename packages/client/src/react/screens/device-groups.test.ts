import { describe, expect, it } from "vitest";

import type {
  CentraidGatewayDevice,
  GatewayOwner,
} from "../../gateway-client.js";
import { groupDevicesByOwner } from "./device-groups.js";

// `owner_id` is NOT NULL on every binding (#726), so grouping is total: the
// interesting cases are what happens when the ROSTER is missing, not what
// happens when a device has no person — that state cannot exist. A vault has
// exactly one owner and a device caller sees only its own owner's vaults, so
// every device this grouping ever sees belongs to the SAME person.

function device(
  over: Partial<CentraidGatewayDevice> = {}
): CentraidGatewayDevice {
  return {
    deviceId: "enr_1",
    endpointId: "ep_1",
    ownerId: "o-priya",
    ownerLabel: "Priya",
    label: "Browser",
    transport: "iroh",
    vaultId: "v1",
    vaultName: "Personal",
    revoked: false,
    rememberDevice: true,
    ...over,
  };
}

const roster: GatewayOwner[] = [
  {
    ownerId: "o-priya",
    label: "Priya",
    createdAt: "2026-07-01T00:00:00.000Z",
    vaults: [{ vaultId: "v1", vaultName: "Personal" }],
    deviceCount: 1,
  },
];

describe(groupDevicesByOwner, () => {
  it("reads a person’s vaults off their bindings when the roster is unavailable", () => {
    const groups = groupDevicesByOwner([device()], []);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBe("Priya");
    expect(groups[0]?.vaults).toStrictEqual([
      { vaultId: "v1", vaultName: "Personal" },
    ]);
  });

  it("prefers the roster’s authored vaults over the inherited ones", () => {
    const groups = groupDevicesByOwner(
      [device()],
      [
        {
          ...roster[0]!,
          vaults: [
            { vaultId: "v1", vaultName: "Personal" },
            { vaultId: "v2", vaultName: "Shared" },
          ],
        },
      ]
    );
    expect(groups[0]?.vaults).toStrictEqual([
      { vaultId: "v1", vaultName: "Personal" },
      { vaultId: "v2", vaultName: "Shared" },
    ]);
  });

  it("splits tombstones out of the live device list", () => {
    const groups = groupDevicesByOwner(
      [device(), device({ deviceId: "enr_2", revoked: true })],
      roster
    );
    expect(groups[0]?.devices.map((d) => d.deviceId)).toStrictEqual(["enr_1"]);
    expect(groups[0]?.revoked.map((d) => d.deviceId)).toStrictEqual(["enr_2"]);
  });

  it("lists a person with no devices, and sorts the caller first", () => {
    const groups = groupDevicesByOwner(
      [device({ ownerId: "o-arun", ownerLabel: "Arun", current: true })],
      roster
    );
    expect(groups.map((group) => group.label)).toStrictEqual(["Arun", "Priya"]);
    expect(groups[0]?.isSelf).toBe(true);
    expect(groups[1]?.devices).toStrictEqual([]);
  });

  it("folds a device's per-vault enrollments into one hardware row", () => {
    // The devices route returns a row per (device, vault). Two rows for one
    // browser must not render as two devices — a card counting "4 devices"
    // for two, each with a "Revoke device" button that drops one vault.
    const groups = groupDevicesByOwner(
      [
        device({ deviceId: "enr_shared", vaultId: "v1", vaultName: "Shared" }),
        device({
          deviceId: "enr_personal",
          vaultId: "v2",
          vaultName: "Personal",
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
      { vaultId: "v1", vaultName: "Shared" },
      { vaultId: "v2", vaultName: "Personal" },
    ]);
  });

  it("keeps two distinct endpoints apart when they share a person", () => {
    const groups = groupDevicesByOwner(
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
});
