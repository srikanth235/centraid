import { describe, expect, it } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";
import {
  bootstrapVault,
  openVaultDb,
  readCompanionSurfaces,
} from "@centraid/vault";

import { companionHandlerAllowed } from "../engine/http/internal-headers.js";
import {
  companionAccess,
  companionRequestAllowed,
  projectCompanionAttenuation,
  recordCompanionAttenuation,
} from "./companion-access.js";

/** The gateway-side projection store, reduced to the two calls it makes. */
function projectionStore(endpoints: readonly string[]) {
  const projected = new Map<string, string[]>();
  return {
    projected,
    attenuatedEndpointsFor: () => [...endpoints],
    projectSurfaces: (
      endpointId: string,
      vaultId: string,
      surfaces: readonly string[]
    ) => {
      projected.set(`${endpointId}\u0000${vaultId}`, [...surfaces]);
    },
  };
}

describe("Companion gateway surface", () => {
  it("allows DELETE only for the authenticated enrollment’s own existing route", () => {
    expect(
      companionRequestAllowed(
        { method: "DELETE", url: "/centraid/_gateway/devices/enrollment-1" },
        ["locker"],
        "enrollment-1"
      )
    ).toBe(true);
    expect(
      companionRequestAllowed(
        { method: "DELETE", url: "/centraid/_gateway/devices/enrollment-2" },
        ["locker"],
        "enrollment-1"
      )
    ).toBe(false);
    expect(
      companionRequestAllowed(
        { method: "GET", url: "/centraid/_gateway/devices/enrollment-1" },
        ["locker"],
        "enrollment-1"
      )
    ).toBe(false);
  });

  it("keeps Docs blob staging conditional on the Docs module", () => {
    const request = { method: "POST", url: "/centraid/_vault/blobs" };
    expect(companionRequestAllowed(request, ["locker"], "enrollment-1")).toBe(
      false
    );
    expect(companionRequestAllowed(request, ["docs"], "enrollment-1")).toBe(
      true
    );
  });
});

describe("Companion attenuation is an answer in the vault (#928 A6)", () => {
  const request = { method: "POST", url: "/centraid/notes/queries/list" };

  function vault() {
    const fixture = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Companion owner" }
    );
    return {
      db: fixture.db,
      boot: { vaultId: "v1" },
    };
  }

  it("writes the authority rows first, then projects them", () => {
    const plane = vault();
    const store = projectionStore(["ep-1"]);
    recordCompanionAttenuation(store, plane, {
      endpointId: "ep-1",
      surfaces: ["locker", "notes"],
      now: "2026-09-04T00:00:00.000Z",
    });
    expect(readCompanionSurfaces(plane.db.vault, "ep-1")).toStrictEqual([
      "locker",
      "notes",
    ]);
    expect(store.projected.get("ep-1\u0000v1")).toStrictEqual([
      "locker",
      "notes",
    ]);

    // Dropping a surface revokes its row; the projection follows the rows.
    recordCompanionAttenuation(store, plane, {
      endpointId: "ep-1",
      surfaces: ["locker"],
      now: "2026-09-04T00:01:00.000Z",
    });
    expect(readCompanionSurfaces(plane.db.vault, "ep-1")).toStrictEqual([
      "locker",
    ]);
    expect(projectCompanionAttenuation(store, plane)).toBe(1);
    expect(store.projected.get("ep-1\u0000v1")).toStrictEqual(["locker"]);
  });

  it("[deny matrix] a device attenuated to one surface cannot reach another", () => {
    const plane = vault();
    const store = projectionStore(["ep-1"]);
    recordCompanionAttenuation(store, plane, {
      endpointId: "ep-1",
      surfaces: ["locker"],
      now: "2026-09-04T00:00:00.000Z",
    });
    const surfaces = store.projected.get("ep-1\u0000v1")!;
    const access = companionAccess({
      attenuated: true,
      projected: surfaces,
      req: request,
      enrollmentId: "enrollment-1",
    });
    expect(access.kind).toBe("allowed");
    // The path shape passes; the per-surface gate is what refuses, and it
    // reads exactly the surfaces the rows named.
    const profile = new Set(surfaces);
    expect(companionHandlerAllowed(profile, "query", "notes", "list")).toBe(
      false
    );
    expect(
      companionHandlerAllowed(profile, "query", "locker", "autofill-item")
    ).toBe(true);
  });

  it("an attenuated device with nothing projected is refused, never widened", () => {
    expect(
      companionAccess({
        attenuated: true,
        projected: undefined,
        req: request,
        enrollmentId: "enrollment-1",
      })
    ).toStrictEqual({ kind: "unreadable" });
    // An UNattenuated device is untouched by any of this.
    expect(
      companionAccess({
        attenuated: false,
        projected: undefined,
        req: request,
        enrollmentId: "enrollment-1",
      })
    ).toStrictEqual({ kind: "unattenuated" });
    // A projected-but-empty answer is an answer: it denies every surface.
    expect(
      companionAccess({
        attenuated: true,
        projected: [],
        req: { method: "POST", url: "/centraid/_vault/blobs" },
        enrollmentId: "enrollment-1",
      })
    ).toStrictEqual({ kind: "refused" });
  });
});
