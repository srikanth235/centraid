import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const moduleUrl = (file: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/_shared", file))
    .href;

const { capabilitiesFor } = (await import(
  moduleUrl("grant-plane.ts")
)) as typeof import("../apps/_shared/grant-plane.ts");
const { grantDoor } = (await import(
  moduleUrl("grant-door.ts")
)) as typeof import("../apps/_shared/grant-door.ts");
const { PLACEMENT_REGISTRY } = (await import(
  moduleUrl("placement-registry.ts")
)) as typeof import("../apps/_shared/placement-registry.ts");
const { GRANT_FAILED } = (await import(
  moduleUrl("grant-copy.ts")
)) as typeof import("../apps/_shared/grant-copy.ts");

const ROUTE_REFUSAL =
  "core.document can be shared for view, not for edit; nothing here could keep that promise true";

function refusingDoor(message: string) {
  return grantDoor({
    subjects: () => Promise.resolve({ subjects: [] }),
    forParty: () => Promise.resolve(undefined),
    forAudience: () => Promise.resolve(undefined),
    forSubject: () => Promise.resolve({ grants: [] }),
    create: () => Promise.reject(new Error(message)),
    revoke: () => Promise.reject(new Error(message)),
  });
}

describe("the registry's refusal", () => {
  it("offers nothing for a subject the wire did not name", () => {
    const offers = [
      { subjectType: "core.document", capabilities: ["view"] as const },
    ];
    expect(capabilitiesFor(offers, "locker.item")).toStrictEqual([]);
    expect(capabilitiesFor(offers, "core.document")).toStrictEqual(["view"]);
    expect(capabilitiesFor(offers, "core.document")).not.toContain("edit");
  });

  it("names no first-party subject the placement registry cannot share", () => {
    for (const entity of PLACEMENT_REGISTRY) {
      expect(entity.itemType).not.toBe("locker.item");
    }
  });

  it("carries the vault's refusal to the sheet, verbatim", async () => {
    const outcome = await refusingDoor(ROUTE_REFUSAL).create({
      audienceKind: "party",
      audienceId: "p1",
      subjectType: "core.document",
      subjectId: "d1",
      capability: "edit",
    });
    expect(outcome).toStrictEqual({
      ok: false,
      message: ROUTE_REFUSAL,
      reach: "refused",
    });
    const wordless = await refusingDoor("").create({
      audienceKind: "party",
      audienceId: "p1",
      subjectType: "core.document",
      subjectId: "d1",
      capability: "edit",
    });
    expect(wordless).toStrictEqual({
      ok: false,
      message: GRANT_FAILED,
      reach: "refused",
    });
  });
});
