import { existsSync } from 'node:fs';

export interface LowPriorityCommand {
  bin: string;
  args: string[];
}

/**
 * Wrap an agent/helper child in OS CPU/I/O priority controls (#456 A6).
 * `nice` is universal on supported Unix hosts; Linux additionally gets
 * best-effort idle-ish `ionice`. Windows keeps the original command because
 * Node has no creation-priority flag and correctness must not depend on one.
 */
export function lowPriorityCommand(
  bin: string,
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    exists?: (file: string) => boolean;
  } = {},
): LowPriorityCommand {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  if (platform === 'win32' || process.env.CENTRAID_CHILD_PRIORITY === 'normal') {
    return { bin, args: [...args] };
  }
  const nice = exists('/usr/bin/nice') ? '/usr/bin/nice' : 'nice';
  const niceArgs = ['-n', '10', '--', bin, ...args];
  if (platform !== 'linux') return { bin: nice, args: niceArgs };
  const ionice = ['/usr/bin/ionice', '/bin/ionice'].find(exists);
  return ionice
    ? { bin: ionice, args: ['-c', '2', '-n', '7', nice, ...niceArgs] }
    : { bin: nice, args: niceArgs };
}
