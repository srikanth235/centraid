// Bounded-parallel replication with QoS preemption (#405 §4/§7), held outside
// custody.ts (governance line-cap). Push N blobs at a time: one-at-a-time
// trickles a large import; unbounded collapses the uplink. Between blobs each
// worker awaits `qosWait()`, which parks while an interactive read-through is
// in flight — blob-boundary granularity only, but it keeps interactive reads
// alive during bulk replication.

export type QosWait = () => Promise<void>;

export interface ReplicateDriverOptions {
  want: readonly string[];
  /** Shas already on the remote tier — skipped. */
  alreadyThere: Set<string>;
  /** Push exactly one sha; true when it moved, false when it raced a delete. */
  pushOne: (sha: string) => Promise<boolean>;
  concurrency: number;
  qosWait: QosWait;
}

/** Fixed worker pool over the backlog, each worker gated by `qosWait` before claiming its next sha. Returns shas that actually moved (unordered). */
export async function driveReplication(
  options: ReplicateDriverOptions
): Promise<string[]> {
  const queue = options.want.filter((sha) => !options.alreadyThere.has(sha));
  const moved: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    await options.qosWait();
    const i = next++;
    if (i >= queue.length) return;
    const sha = queue[i]!;
    if (await options.pushOne(sha)) moved.push(sha);
    return worker();
  };
  const pool = Math.max(1, Math.min(options.concurrency, queue.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return moved;
}
