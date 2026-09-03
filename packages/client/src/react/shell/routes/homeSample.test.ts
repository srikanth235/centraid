import { describe, expect, it, vi } from "vitest";

import type * as TypeImport_session from "../../../replica/shell-session.js";

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
    sync.mockReset().mockRejectedValue(new Error("gateway unreachable"));
    const { syncHomeSampleReplica } = await import("./homeSample.js");

    await expect(syncHomeSampleReplica()).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledOnce();
  });
});
