export const WATCHED_DIST_FILES = [
  "main.js",
  "preload.cjs",
  "renderer/index.html",
  "renderer/styles.css",
  "renderer/react-boot.js",
] as const;

export interface WatchedStat {
  mtimeMs: number;
  size: number;
}

export function fingerprintOf(
  stats: ReadonlyArray<WatchedStat | null>
): string {
  return stats.map((s) => (s ? `${s.mtimeMs}:${s.size}` : "absent")).join("|");
}

export type PollVerdict = "unchanged" | "settling" | "update-available";

export class UpdatePoller {
  private readonly baseline: string;
  private prev: string;
  private announced = false;

  constructor(baseline: string) {
    this.baseline = baseline;
    this.prev = baseline;
  }

  get available(): boolean {
    return this.announced;
  }

  tick(fingerprint: string): PollVerdict {
    const settled = fingerprint === this.prev;
    this.prev = fingerprint;
    if (fingerprint === this.baseline) return "unchanged";
    if (!settled) return "settling";
    if (this.announced) return "unchanged";
    this.announced = true;
    return "update-available";
  }
}
