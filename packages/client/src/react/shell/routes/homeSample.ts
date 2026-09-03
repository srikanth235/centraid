import {
  vaultDemoLoad,
  vaultDemoPurge,
  vaultDemoStatus,
} from "../../../gateway-client.js";

export interface HomeSampleState {
  seedable: readonly string[];
  rows: number;
}

export const NO_SAMPLE: HomeSampleState = { rows: 0, seedable: [] };

export async function loadHomeSample(): Promise<HomeSampleState> {
  try {
    const apps = await vaultDemoStatus();
    return {
      rows: apps.reduce((total, app) => total + app.rows, 0),
      seedable: apps.filter((app) => app.seedable).map((app) => app.appId),
    };
  } catch {
    return NO_SAMPLE;
  }
}

export interface HomeSampleProgress {
  done: number;
  total: number;
  appId?: string;
}

export async function seedHomeSample(
  seedable: readonly string[],
  onProgress?: (progress: HomeSampleProgress) => void
): Promise<readonly string[]> {
  const seeded: string[] = [];
  for (const [index, appId] of seedable.entries()) {
    onProgress?.({ appId, done: index, total: seedable.length });
    try {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await vaultDemoLoad(appId);
      seeded.push(appId);
    } catch {
      // Intentionally empty.
    }
  }
  return seeded;
}

export async function clearHomeSample(): Promise<void> {
  await vaultDemoPurge();
}

export async function syncHomeSampleReplica(): Promise<void> {
  try {
    const { getReplicaShellSession } =
      await import("../../../replica/shell-session.js");
    await (await getReplicaShellSession()).sync();
  } catch {
    // Intentionally empty.
  }
}
