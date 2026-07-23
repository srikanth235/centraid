import { existsSync } from 'node:fs';

export interface LowPriorityCommand {
  bin: string;
  args: string[];
}

/** Default child `nice` increment — a courteous but not starved background priority. */
const DEFAULT_NICENESS = 10;

/**
 * Wrap an agent/helper child in OS CPU/I/O priority controls (#456 A6, #528
 * Phase D). Per-platform mapping of what actually applies:
 *   - Linux: `nice` (CPU) + best-effort idle-class `ionice` (I/O); a child
 *     could additionally opt into `SCHED_IDLE`, but that needs a syscall wrapper
 *     we don't ship, so `nice`/`ionice` are the portable floor.
 *   - macOS: `nice` (CPU). App Nap applies to the child on its own when it's
 *     backgrounded and not holding power assertions — no flag to pass.
 *   - Windows: no wrapper — Node has no creation-priority flag, so correctness
 *     must not depend on one. `CENTRAID_CHILD_PRIORITY=normal` is the documented
 *     passthrough to disable wrapping everywhere; a future EcoQoS
 *     (PROCESS_POWER_THROTTLING) opt-in is deferred.
 *
 * worker_threads DEFERRED: Node cannot set per-thread OS priority portably
 * (no cross-platform tid-based `setPriority`), so pool threads inherit the
 * process priority — do not hack a tid lookup to force it.
 *
 * `niceness` overrides the default increment (still ignored on Windows and
 * when `CENTRAID_CHILD_PRIORITY=normal`).
 */
export function lowPriorityCommand(
  bin: string,
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    exists?: (file: string) => boolean;
    niceness?: number;
  } = {},
): LowPriorityCommand {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const niceness = options.niceness ?? DEFAULT_NICENESS;
  if (platform === 'win32' || process.env.CENTRAID_CHILD_PRIORITY === 'normal') {
    return { bin, args: [...args] };
  }
  const nice = exists('/usr/bin/nice') ? '/usr/bin/nice' : 'nice';
  const niceArgs = ['-n', String(niceness), '--', bin, ...args];
  if (platform !== 'linux') return { bin: nice, args: niceArgs };
  const ionice = ['/usr/bin/ionice', '/bin/ionice'].find(exists);
  return ionice
    ? { bin: ionice, args: ['-c', '2', '-n', '7', nice, ...niceArgs] }
    : { bin: nice, args: niceArgs };
}
