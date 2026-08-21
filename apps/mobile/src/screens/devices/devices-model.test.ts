/**
 * The Devices place's copy and grouping contract (issue #765, spec §7).
 *
 * Pure model, so what is under test is the wording, the roster split and the
 * five states — not a renderer. The rules that are cheap to undo and expensive
 * to lose: the roster splits on OWNER (never on a row index), a revoked
 * binding stays as an inert row, a one-device roster is the empty state, and a
 * 409 on revocation escalates to the typed-vault-name confirm exactly once.
 */
import { describe, expect, it } from "vitest";

import { healthLineFor } from "../../kit/components/health-line";
import type { DeviceRow, DeviceTicket } from "../../lib/devices";
import {
  devicesHealthCopy,
  devicesState,
  deviceRowCopy,
  hasOtherPeople,
  isLastDeviceRefusal,
  memberDeviceError,
  rosterGroups,
  selfOwnerId,
  strandedVaultName,
  ticketFacts,
  vaultRowCopy,
} from "./devices-model";

function device(patch: Partial<DeviceRow> & { deviceId: string }): DeviceRow {
  return {
    endpointId: `endpoint-${patch.deviceId}`,
    label: "A device",
    ownerId: "alex",
    ownerLabel: "Alex Pemberton",
    rememberDevice: true,
    revoked: false,
    vaultId: "vault-1",
    ...patch,
  };
}

describe("device row copy", () => {
  it("lowers architecture nouns out of member-facing connection errors", () => {
    expect(memberDeviceError(new Error("Gateway returned HTTP 503"), "x")).toBe(
      "home machine returned HTTP 503"
    );
    expect(
      memberDeviceError(new Error("Replica component is unavailable"), "x")
    ).toBe("offline copy part is unavailable");
    expect(memberDeviceError(null, "Could not read the copies.")).toBe(
      "Could not read the copies."
    );
  });
  it("names this device, what it computes and when it was paired", () => {
    const row = deviceRowCopy(
      device({
        addedAt: "2026-03-03T10:00:00.000Z",
        compute: {
          capabilities: {
            backgroundTransfer: false,
            edgeSeal: false,
            embedding: false,
            ocr: false,
            pdfText: false,
            poster: false,
            previews: true,
            transcript: false,
          },
          contributeWhileCharging: true,
          updatedAt: "2026-03-03T10:00:00.000Z",
        },
        current: true,
        deviceId: "d1",
        label: "Alex's MacBook Pro",
        platform: "macOS",
      }),
      false
    );
    expect(row.title).toBe("Alex's MacBook Pro");
    expect(row.meta).toBe("This device");
    expect(row.sub).toContain("This device · contributing compute · macOS");
    expect(row.sub).toContain("paired ");
    expect(row.off).toBe(false);
  });

  it("names the person on someone else's row, and only there", () => {
    const other = deviceRowCopy(
      device({ deviceId: "d2", ownerId: "ana", ownerLabel: "Ana" }),
      true
    );
    expect(other.sub).toContain("Ana");
    expect(other.meta).toBe("Other person");
    expect(deviceRowCopy(device({ deviceId: "d3" }), false).sub).not.toContain(
      "Alex Pemberton"
    );
  });

  it("says nothing about compute when the wire says nothing", () => {
    expect(deviceRowCopy(device({ deviceId: "d4" }), false).sub).not.toContain(
      "compute"
    );
  });

  it("keeps a revoked binding as an inert row", () => {
    const row = deviceRowCopy(device({ deviceId: "d5", revoked: true }), false);
    expect(row.meta).toBe("Revoked");
    expect(row.off).toBe(true);
  });
});

describe("roster grouping", () => {
  const mine = device({ current: true, deviceId: "d1" });
  const alsoMine = device({ deviceId: "d2" });
  const theirs = device({
    deviceId: "d3",
    ownerId: "ana",
    ownerLabel: "Ana Pemberton",
  });

  it("splits Yours from Other people on the owner", () => {
    const groups = rosterGroups([mine, theirs, alsoMine]);
    expect(groups.map((group) => group.label)).toStrictEqual([
      "Yours",
      "Other people",
    ]);
    expect(groups[0]?.meta).toBe("2");
    expect(groups[0]?.devices).toStrictEqual([mine, alsoMine]);
    expect(groups[1]?.devices).toStrictEqual([theirs]);
    expect(hasOtherPeople(groups)).toBe(true);
  });

  it("publishes no Other people band when every device is yours", () => {
    const groups = rosterGroups([mine, alsoMine]);
    expect(groups).toHaveLength(1);
    expect(hasOtherPeople(groups)).toBe(false);
  });

  it("names bands after their owner rather than guessing which is yours", () => {
    const groups = rosterGroups([alsoMine, theirs]);
    expect(selfOwnerId([alsoMine, theirs])).toBeUndefined();
    expect(groups.map((group) => group.label)).toStrictEqual([
      "Alex Pemberton",
      "Ana Pemberton",
    ]);
    expect(hasOtherPeople(groups)).toBe(true);
  });

  it("still knows whose a roster is when one owner holds all of it", () => {
    expect(selfOwnerId([alsoMine])).toBe("alex");
    expect(rosterGroups([alsoMine])[0]?.label).toBe("Yours");
  });
});

describe("the five states", () => {
  const one = device({ current: true, deviceId: "d1" });
  const many = Array.from({ length: 8 }, (_, index) =>
    device({ deviceId: `d${index}` })
  );

  it("reads a lone enrollment as empty, not as a list of one", () => {
    expect(devicesState({ devices: [one], status: "ready" })).toBe("empty");
  });

  it("counts only live bindings toward the roster", () => {
    const withTombstone = [one, device({ deviceId: "gone", revoked: true })];
    expect(devicesState({ devices: withTombstone, status: "ready" })).toBe(
      "empty"
    );
  });

  it("steps up to full at the reference's roster size", () => {
    expect(devicesState({ devices: many.slice(0, 4), status: "ready" })).toBe(
      "ready"
    );
    expect(devicesState({ devices: many, status: "ready" })).toBe("full");
  });

  it("lets loading and error win over any count", () => {
    expect(devicesState({ devices: many, status: "loading" })).toBe("loading");
    expect(devicesState({ devices: many, status: "error" })).toBe("error");
  });
});

describe("the standing line", () => {
  const roster = [
    device({ current: true, deviceId: "d1" }),
    device({ deviceId: "d2", ownerId: "ana", ownerLabel: "Ana" }),
  ];

  it("reports an unredeemed ticket as the pending request it is", () => {
    const line = healthLineFor(
      "ready",
      devicesHealthCopy({ devices: roster, pendingTickets: 1 })
    );
    expect(line.text).toBe(
      "1 request is pending · A pairing ticket minted here has not been used yet."
    );
    // Nothing to review that is not already on the screen.
    expect(line.action).toBeUndefined();
  });

  it("counts people, not enrollments, when nothing is pending", () => {
    const line = healthLineFor(
      "full",
      devicesHealthCopy({ devices: roster, pendingTickets: 0 })
    );
    expect(line.text).toBe(
      "2 devices paired · 2 people, and nothing is waiting to be accepted."
    );
  });

  it("says the generic sentence in the three states that have no facts", () => {
    const copy = devicesHealthCopy({ devices: [], pendingTickets: 0 });
    expect(healthLineFor("loading", copy).text).toBe(
      "Reading the devices paired with this vault."
    );
    expect(healthLineFor("empty", copy).text).toBe(
      "Only this device is enrolled."
    );
    expect(healthLineFor("error", copy).text).toBe(
      "Your vault's home machine has not answered, so this roster may be stale."
    );
  });
});

describe("the pairing ticket", () => {
  it("says who it is for, what it reaches and when it dies", () => {
    const ticket: DeviceTicket = {
      expiresAt: "2026-08-13T09:30:00.000Z",
      ownerId: "alex",
      ownerLabel: "Alex Pemberton",
      ticket: "token",
      vaultId: "vault-1",
      vaults: [
        { vaultId: "vault-1", vaultName: "Pemberton vault" },
        { vaultId: "vault-2" },
      ],
    };
    const facts = ticketFacts(ticket);
    expect(facts.map((fact) => fact.label)).toStrictEqual([
      "for",
      "reaches",
      "expires",
    ]);
    expect(facts[0]?.value).toBe("Alex Pemberton");
    expect(facts[1]?.value).toBe("Pemberton vault, vault-2");
    expect(facts[2]?.value).not.toBe("");
  });
});

describe("the last-device refusal", () => {
  it("reads the gateway's 409 as the stranding refusal", () => {
    expect(isLastDeviceRefusal(new Error("Gateway returned HTTP 409"))).toBe(
      true
    );
    expect(isLastDeviceRefusal(new Error("Gateway returned HTTP 404"))).toBe(
      false
    );
    expect(isLastDeviceRefusal("409")).toBe(false);
  });

  it("names the vault whose name the member has to type", () => {
    expect(
      strandedVaultName(device({ deviceId: "d1", vaultName: "Work" }))
    ).toBe("Work");
    expect(strandedVaultName(device({ deviceId: "d1" }))).toBe("vault-1");
  });
});

describe("owned vaults", () => {
  it("renders a vault as a fact row with no verb", () => {
    const row = vaultRowCopy({
      name: "Pemberton vault",
      ownerPartyId: "alex",
      vaultId: "vault-1",
    });
    expect(row.title).toBe("Pemberton vault");
    expect(row.sub).toBe("vault-1");
    expect(row.meta).toBe("");
  });
});
