import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { app } from "electron";

import { shouldAdmitUpdate, stableBucketId } from "./update-rollout-core.js";

const INSTALL_ID_FILE = "install-id";

export async function getOrCreateInstallId(): Promise<string> {
  const file = path.join(app.getPath("userData"), INSTALL_ID_FILE);
  try {
    const existing = (await fs.readFile(file, "utf8")).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Intentionally empty.
  }
  const id = randomUUID();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, id, { mode: 0o600 });
  return id;
}

export async function getInstallRolloutBucket(): Promise<number> {
  return stableBucketId(await getOrCreateInstallId());
}

export async function admitUpdate(input: {
  releasedAtMs?: number | null;
  nowMs?: number;
  manualCheck?: boolean;
  windowMs?: number;
}): Promise<boolean> {
  const bucket = await getInstallRolloutBucket();
  return shouldAdmitUpdate({
    bucket,
    releasedAtMs: input.releasedAtMs,
    nowMs: input.nowMs ?? Date.now(),
    ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
    ...(input.manualCheck === undefined
      ? {}
      : { manualCheck: input.manualCheck }),
  });
}
