import type { MobileReplicaSession } from "../replica/native-session";

export type CameraRollSweepReason =
  | "app-start"
  | "foreground"
  | "library-changed"
  | "background-pass";

export interface CameraRollTrigger {
  reason: CameraRollSweepReason;
  fires: string;
  cannot: string;
}

export const CAMERA_ROLL_TRIGGERS: readonly CameraRollTrigger[] = [
  {
    reason: "app-start",
    fires: "once per launch, as soon as a vault session exists",
    cannot: "run before the phone is paired to a gateway",
  },
  {
    reason: "foreground",
    fires: "every return to the app from the background or the switcher",
    cannot: "run while the app is backgrounded or killed",
  },
  {
    reason: "library-changed",
    fires:
      "within seconds of a new photograph while the app process is alive and foregrounded",
    cannot:
      "be delivered to a suspended or killed app — the OS wakes no JavaScript for a camera shutter",
  },
  {
    reason: "background-pass",
    fires:
      "never — the headless pass DRAINS what is already queued and does not discover new photographs",
    cannot:
      "walk the roll: discovery is a full camera-roll walk plus a replica read, which does not fit the pass's 20s budget (docs/mobile-offline.md, Background work). New photographs therefore wait for the next foreground.",
  },
];

export interface CameraRollScope {
  session: MobileReplicaSession;
  gatewayBase: string;
  vaultId?: string;
}

export type CameraRollSweep = (scope: CameraRollScope) => Promise<void>;

let registered: CameraRollSweep | undefined;
let scope: CameraRollScope | undefined;
let running = false;
let lastRunAt = 0;

export const CAMERA_ROLL_MIN_INTERVAL_MS = 60_000;

export function registerCameraRollSweep(sweep: CameraRollSweep): () => void {
  registered = sweep;
  return () => {
    if (registered === sweep) registered = undefined;
  };
}

export function mayRunSweep(
  reason: CameraRollSweepReason,
  state: { running: boolean; lastRunAt: number },
  now: number,
  minIntervalMs = CAMERA_ROLL_MIN_INTERVAL_MS
): boolean {
  if (state.running) return false;
  if (reason !== "library-changed") return true;
  return now - state.lastRunAt >= minIntervalMs;
}

export async function runCameraRollSweep(
  reason: CameraRollSweepReason
): Promise<boolean> {
  const sweep = registered;
  const target = scope;
  if (!sweep || !target) return false;
  if (!mayRunSweep(reason, { running, lastRunAt }, Date.now())) return false;
  running = true;
  try {
    await sweep(target);
    return true;
  } catch {
    return false;
  } finally {
    running = false;
    lastRunAt = Date.now();
  }
}

export function resetCameraRollWatcher(): void {
  registered = undefined;
  scope = undefined;
  running = false;
  lastRunAt = 0;
}

export function setCameraRollScope(next: CameraRollScope | undefined): void {
  scope = next;
}
