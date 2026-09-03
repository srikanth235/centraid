import { describe, expect, it } from "vitest";

import type { GroupedDevice } from "./device-groups.js";
import {
  custodyCounts,
  custodyLine,
  holdsReplica,
  replicaClause,
  seenAge,
} from "./vault-custody.js";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");

function device(over: Partial<GroupedDevice> = {}): GroupedDevice {
  return {
    addedAt: "2026-03-03T09:00:00.000Z",
    deviceId: "d1",
    endpointId: "e1",
    enrollmentIds: ["d1"],
    label: "MacBook Pro",
    ownerId: "o1",
    ownerLabel: "Alex",
    rememberDevice: false,
    revoked: false,
    transport: "iroh",
    vaultId: "v1",
    vaults: [{ vaultId: "v1" }],
    ...over,
  };
}

describe("vault custody", () => {
  describe("copies and enrolment", () => {
    it("counts the two separately — reaching a vault is not holding one", () => {
      const roster = [
        device({ endpointId: "e1", rememberDevice: true }),
        device({ endpointId: "e2", rememberDevice: true }),
        device({ endpointId: "e3" }),
        device({ endpointId: "e4" }),
        device({ endpointId: "e5" }),
        device({ endpointId: "e6" }),
      ];
      expect(custodyCounts(roster)).toStrictEqual({ devices: 6, replicas: 2 });
      expect(custodyLine(custodyCounts(roster), 41_208)).toBe(
        "41,208 records · 2 machines hold a full copy · 6 devices enrolled"
      );
    });

    it("omits the record clause rather than guessing when the census cannot say", () => {
      const line = custodyLine({ devices: 1, replicas: 1 }, null);
      expect(line).toBe("1 machine holds a full copy · 1 device enrolled");
      expect(line).not.toContain("records");
    });

    it("quotes ONE replica string on the row, the drill-in and the line", () => {
      expect(holdsReplica(device({ rememberDevice: true }))).toBe(true);
      expect(replicaClause(device({ rememberDevice: true }))).toBe(
        "holds a full copy"
      );
      expect(replicaClause(device())).toBe("reads from the gateway");
    });
  });

  describe("the bare age", () => {
    it("reads as a sentence can carry it, in singular forms", () => {
      const ago = (ms: number): string =>
        seenAge(new Date(NOW - ms).toISOString(), NOW);
      expect(ago(10_000)).toBe("just now");
      expect(ago(9 * 60_000)).toBe("9 min ago");
      expect(ago(70 * 60_000)).toBe("an hour ago");
      expect(ago(5 * 3_600_000)).toBe("5 hours ago");
      expect(ago(30 * 3_600_000)).toBe("yesterday");
      expect(ago(3 * 86_400_000)).toBe("3 days ago");
    });

    it("says nothing at all when there is no timestamp to read", () => {
      expect(seenAge(undefined, NOW)).toBe("");
      expect(seenAge("not a date", NOW)).toBe("");
    });
  });
});
