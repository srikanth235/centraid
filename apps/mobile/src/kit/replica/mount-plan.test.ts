import { describe, expect, it } from "vitest";

import { planMount } from "./mount-plan";
import type { MountPlanInput } from "./mount-plan";

const CACHED_BASE = "http://127.0.0.1:51890";
const GATEWAY = "2315e0468b58adbbf0411da619288dbbb334b40d14ff4ca51cf32a069336";

describe("what the phone opens on a cold start", () => {
  // THE ONE THIS MODULE EXISTS FOR. A returning device holds the whole vault in
  // a SQLite file it wrote itself. Before this, mounting it waited on a tunnel
  // that had no timeout, so a launch with the desktop asleep never opened the
  // database at all — verified on device: the replica file's mtime did not move
  // across an entire launch while it held 528 rows.
  it("opens the replica this device already has without asking the network", () => {
    const plan = planMount({
      link: { gatewayId: GATEWAY, vaultId: "vault-1" },
      cachedBase: CACHED_BASE,
    });

    expect(plan).toStrictEqual({
      kind: "open",
      baseUrl: CACHED_BASE,
      gatewayId: GATEWAY,
      vaultId: "vault-1",
    });
  });

  it("falls back to the persisted active slot when the registry row is incomplete", () => {
    // A freshly paired row carries `vaultId: ''` until the first probe fills it
    // in, but a device that has completed that probe before has the answer in
    // the slot vault-links projects beside the registry.
    const plan = planMount({
      link: { gatewayId: GATEWAY, vaultId: "" },
      cachedBase: CACHED_BASE,
      lastIdentity: { gatewayId: GATEWAY, vaultId: "vault-9" },
    });

    expect(plan).toMatchObject({ kind: "open", vaultId: "vault-9" });
  });

  it("prefers the registry row over the slot when the two disagree", () => {
    // Switching a VaultLink writes the row first, so the row is the newer fact.
    const plan = planMount({
      link: { gatewayId: GATEWAY, vaultId: "vault-new" },
      cachedBase: CACHED_BASE,
      lastIdentity: { gatewayId: GATEWAY, vaultId: "vault-old" },
    });

    expect(plan).toMatchObject({ kind: "open", vaultId: "vault-new" });
  });

  it("probes only when this device has no persisted identity at all", () => {
    // The one honest reason to touch the network before opening anything: the
    // gateway holds the only copy of the answer. This is a fresh install.
    expect(planMount({ cachedBase: CACHED_BASE })).toStrictEqual({
      kind: "probe",
    });
  });

  it("treats a half-known tuple as nothing, since it cannot name a database", () => {
    for (const input of [
      { link: { gatewayId: GATEWAY }, cachedBase: CACHED_BASE },
      { link: { vaultId: "vault-1" }, cachedBase: CACHED_BASE },
      {
        cachedBase: CACHED_BASE,
        lastIdentity: { gatewayId: "", vaultId: "vault-1" },
      },
      {
        cachedBase: CACHED_BASE,
        lastIdentity: { gatewayId: GATEWAY, vaultId: "" },
      },
    ] satisfies MountPlanInput[]) {
      expect(planMount(input).kind).toBe("probe");
    }
  });
});

describe("the plan a mount is allowed to produce", () => {
  const links = [
    undefined,
    {},
    { gatewayId: GATEWAY },
    { vaultId: "vault-1" },
    { gatewayId: GATEWAY, vaultId: "vault-1" },
  ];
  const slots = [
    undefined,
    { gatewayId: "", vaultId: "" },
    { gatewayId: GATEWAY, vaultId: "" },
    { gatewayId: "", vaultId: "vault-2" },
    { gatewayId: GATEWAY, vaultId: "vault-2" },
  ];
  const bases = ["http://127.0.0.1", CACHED_BASE];
  const matrix: MountPlanInput[] = links.flatMap((link) =>
    slots.flatMap((lastIdentity) =>
      bases.map((cachedBase) => ({
        ...(link ? { link } : {}),
        ...(lastIdentity ? { lastIdentity } : {}),
        cachedBase,
      }))
    )
  );

  // THE PIN. Phase A has two answers and neither of them is "wait". If a third
  // shape ever appears — a `pending`, a promise, a "resolve the base first" —
  // this fails, and it should: that shape IS the defect, which was a cold start
  // that withheld local data because a tunnel never answered.
  it("never answers a mount with wait-for-the-network", () => {
    for (const input of matrix) {
      const plan = planMount(input);
      expect(["open", "probe"]).toContain(plan.kind);
    }
  });

  it("opens from disk whenever any complete identity is on disk", () => {
    for (const input of matrix) {
      const onDisk =
        (input.link?.gatewayId && input.link.vaultId) ||
        (input.lastIdentity?.gatewayId && input.lastIdentity.vaultId);
      expect(planMount(input).kind).toBe(onDisk ? "open" : "probe");
    }
  });

  it("opens against the cached base rather than an address it has to earn", () => {
    const wrongBase = matrix.filter((input) => {
      const plan = planMount(input);
      return plan.kind === "open" && plan.baseUrl !== input.cachedBase;
    });
    expect(wrongBase).toStrictEqual([]);
  });
});
