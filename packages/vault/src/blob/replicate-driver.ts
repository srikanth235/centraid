// Bounded-parallel replication with QoS preemption (issue #405 §4/§7) — the
// orchestration lifted out of custody.ts (which is at the governance line-cap)
// so the facade keeps just the per-blob push. Two coarse-but-real v0 levers:
//
//   BOUNDED PARALLELISM (§4): push N blobs at a time (default 3-4), not the
//   whole backlog serially and not all at once — one blob-at-a-time today means
//   a 500 GB import trickles; unbounded would collapse the uplink.
//
//   QoS (§7): an interactive read-through (custody.open pulling a remote-only
//   blob the user is looking at RIGHT NOW) preempts bulk replication. Between
//   blobs each worker awaits `qosWait()`, which parks while an interactive read
//   is in flight (plus a short cooldown). Coarse — it pauses at blob boundaries,
//   not mid-multipart — but it is the difference between "import your library"
//   and "the phone collapses" on week one.

/** Injectable QoS gate: resolves when it is OK to start the next bulk push. */
export type QosWait = () => Promise<void>;

export interface ReplicateDriverOptions {
  /** Shas to consider pushing (the local set, or a caller-supplied subset). */
  want: readonly string[];
  /** Shas already known to be on the remote tier (index or listing). Skipped. */
  alreadyThere: Set<string>;
  /** Push exactly one sha; resolves true when it moved, false when it raced a delete. */
  pushOne: (sha: string) => Promise<boolean>;
  /** Max concurrent pushes (issue #405 §4). */
  concurrency: number;
  /** Awaited between blobs to yield to interactive reads (issue #405 §7). */
  qosWait: QosWait;
}

/**
 * Drive the backlog through a fixed pool of `concurrency` workers, each
 * awaiting the QoS gate before claiming its next sha. Returns the shas that
 * actually moved (order is not significant — the caller reports a set).
 */
export async function driveReplication(options: ReplicateDriverOptions): Promise<string[]> {
  const queue = options.want.filter((sha) => !options.alreadyThere.has(sha));
  const moved: string[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      await options.qosWait();
      const i = next++;
      if (i >= queue.length) return;
      const sha = queue[i]!;
      if (await options.pushOne(sha)) moved.push(sha);
    }
  };
  const pool = Math.max(1, Math.min(options.concurrency, queue.length));
  await Promise.all(Array.from({ length: pool }, () => worker()));
  return moved;
}
