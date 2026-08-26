import { existsSync } from "node:fs";

export interface LowPriorityCommand {
  bin: string;
  args: string[];
}

const DEFAULT_NICENESS = 10;

/**
 * OS CPU/I/O priority controls (#456/#528): nice (+ionice on Linux), none on
 * Windows. worker_threads DEFERRED — do not hack a tid lookup.
 */
export function lowPriorityCommand(
  bin: string,
  args: readonly string[],
  options: {
    platform?: NodeJS.Platform;
    exists?: (file: string) => boolean;
    niceness?: number;
  } = {}
): LowPriorityCommand {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const niceness = options.niceness ?? DEFAULT_NICENESS;
  if (
    platform === "win32" ||
    process.env.CENTRAID_CHILD_PRIORITY === "normal"
  ) {
    return { bin, args: [...args] };
  }
  const nice = exists("/usr/bin/nice") ? "/usr/bin/nice" : "nice";
  const niceArgs = ["-n", String(niceness), "--", bin, ...args];
  if (platform !== "linux") return { bin: nice, args: niceArgs };
  const ionice = ["/usr/bin/ionice", "/bin/ionice"].find(exists);
  return ionice
    ? { bin: ionice, args: ["-c", "2", "-n", "7", nice, ...niceArgs] }
    : { bin: nice, args: niceArgs };
}
