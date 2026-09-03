export interface CatchUpStatus {
  turnCount: number;
  updatedAt: number;
}

export interface CatchUpOptions {
  baselineTurnCount: number;
  getStatus: () => Promise<CatchUpStatus>;
  isCancelled?: () => boolean;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function catchUpAfterDrop(opts: CatchUpOptions): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  const target = opts.baselineTurnCount + 1;
  const poll = async (): Promise<boolean> => {
    if (opts.isCancelled?.()) return false;
    try {
      const status = await opts.getStatus();
      if (status.turnCount >= target) return true;
    } catch {
      // Intentionally empty.
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
    return poll();
  };
  return poll();
}
