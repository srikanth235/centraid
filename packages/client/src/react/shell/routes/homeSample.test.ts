import { describe, expect, it, vi } from "vitest";

import type * as TypeImport_session from "../../../replica/shell-session.js";

// The demo plane's HTTP calls are contract-tested against the gateway
// fixtures; what this file owns is the shape of the RUN — the order it steps
// through the apps in and what it reports while it does — plus the replica
// catch-up that makes the seed's payoff visible without a reload, and its
// fail-soft contract.

const sync = vi.fn<() => Promise<void>>();
const getReplicaShellSession = vi.fn<
  () => Promise<TypeImport_session.ReplicaShellSession>
>(async () => ({ sync }) as unknown as TypeImport_session.ReplicaShellSession);
vi.mock(import("../../../replica/shell-session.js"), () => ({
  getReplicaShellSession: () => getReplicaShellSession(),
}));
const vaultDemoLoad = vi.fn<(appId: string) => Promise<{ rows: number }>>();
vi.mock(import("../../../gateway-client.js"), () => ({
  vaultDemoLoad: (appId: string) => vaultDemoLoad(appId),
  vaultDemoPurge: () => Promise.resolve({ purged: 0, blocked: [] }),
  vaultDemoStatus: () => Promise.resolve([]),
}));

const APPS = ["agenda", "docs", "notes", "people", "photos", "tally", "tasks"];

describe("seedHomeSample", () => {
  it("reports the app it is WAITING ON, in order, as it steps through them", async () => {
    // The whole point of sequencing the run: the fill takes about ten seconds
    // and the surface can only describe it if the run has a position. Reported
    // BEFORE each generator, because the sentence has to name what is in
    // flight — "adding photographs" after the ten uploads landed describes
    // nothing.
    vaultDemoLoad.mockReset().mockResolvedValue({ rows: 3 });
    const seen: { appId?: string; done: number; total: number }[] = [];
    const { seedHomeSample } = await import("./homeSample.js");

    const seeded = await seedHomeSample(APPS, (progress) =>
      seen.push(progress)
    );

    expect(seen).toStrictEqual(
      APPS.map((appId, done) => ({ appId, done, total: APPS.length }))
    );
    expect(seeded).toStrictEqual(APPS);
    expect(vaultDemoLoad.mock.calls.map(([appId]) => appId)).toStrictEqual(
      APPS
    );
  });

  it("keeps a failing generator off the result and carries the run on", async () => {
    // Unchanged from the concurrent version's `allSettled` contract: one
    // generator throwing is not the others' problem, and the failure is
    // reported by omission from the returned ids. Seven filled tiles beside
    // one that still says what to do beats an empty Home and an error.
    vaultDemoLoad.mockReset().mockImplementation(async (appId: string) => {
      if (appId === "photos") throw new Error("upload failed");
      return { rows: 3 };
    });
    const seen: { appId?: string }[] = [];
    const { seedHomeSample } = await import("./homeSample.js");

    const seeded = await seedHomeSample(APPS, (progress) =>
      seen.push(progress)
    );

    expect(seeded).toStrictEqual(APPS.filter((appId) => appId !== "photos"));
    // And the run reported every app, including the one that failed — the
    // progress line is where the fill IS, not where it succeeded.
    expect(seen.map((progress) => progress.appId)).toStrictEqual(APPS);
  });

  it("reports nothing when there is nothing to seed", async () => {
    vaultDemoLoad.mockReset();
    const onProgress = vi.fn<(progress: { done: number }) => void>();
    const { seedHomeSample } = await import("./homeSample.js");

    await expect(seedHomeSample([], onProgress)).resolves.toStrictEqual([]);
    expect(onProgress).not.toHaveBeenCalled();
    expect(vaultDemoLoad).not.toHaveBeenCalled();
  });
});

describe("syncHomeSampleReplica", () => {
  it("awaits the shell session's replica pull", async () => {
    sync.mockReset().mockResolvedValue(undefined);
    const { syncHomeSampleReplica } = await import("./homeSample.js");

    await syncHomeSampleReplica();

    expect(sync).toHaveBeenCalledOnce();
  });

  it("resolves when the sync cannot run — stale beats stuck", async () => {
    // The chosen degradation: a failed pull must NOT reject, because the
    // caller's refresh still runs behind it and repaints whatever IS local —
    // slightly stale tiles that the next feed nudge repairs, rather than a
    // front door stuck on `busy` with the seed already on the gateway.
    sync.mockReset().mockRejectedValue(new Error("gateway unreachable"));
    const { syncHomeSampleReplica } = await import("./homeSample.js");

    await expect(syncHomeSampleReplica()).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledOnce();
  });
});
