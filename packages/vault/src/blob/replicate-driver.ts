export type QosWait = () => Promise<void>;

export interface ReplicateDriverOptions {
  want: readonly string[];
  alreadyThere: Set<string>;
  pushOne: (sha: string) => Promise<boolean>;
  concurrency: number;
  qosWait: QosWait;
}

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
