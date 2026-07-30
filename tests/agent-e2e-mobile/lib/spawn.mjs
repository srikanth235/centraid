import { spawn } from "node:child_process";

const KILL_GRACE_MS = 5_000;

function spawnWithTimeout(
  cmd,
  args,
  { errorLabel, stdio, timeoutMs, ...spawnOptions }
) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOptions, stdio });
    let forceKillTimer;
    let settled = false;
    let timedOut = false;

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Maestro is a JVM process and can be stuck below its JS caller. Give it
      // one normal shutdown window, then guarantee the chunk actually ends.
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.once("exit", (code) => {
      finish(() => {
        if (timedOut) {
          reject(
            new Error(
              `${errorLabel} exceeded the ${timeoutMs}ms process timeout`
            )
          );
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${errorLabel} exited ${code}`));
        }
      });
    });
    child.once("error", (error) => finish(() => reject(error)));
  });
}

export function spawnLive(cmd, args, options) {
  return spawnWithTimeout(cmd, args, {
    ...options,
    errorLabel: `${cmd} ${args.join(" ")}`,
    stdio: "inherit",
  });
}

export function spawnQuiet(cmd, args, options) {
  return spawnWithTimeout(cmd, args, {
    ...options,
    // Pairing flows contain a live enrollment capability. Never copy the
    // command arguments into an error or retained verdict.
    errorLabel: `${cmd} sensitive flow`,
    stdio: "ignore",
  });
}
