import { spawn } from "node:child_process";

const KILL_GRACE_MS = 5_000;

function spawnWithTimeout(
  cmd,
  args,
  { errorLabel, onFailure, stdio, timeoutMs, ...spawnOptions }
) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...spawnOptions, stdio });
    let forceKillTimer;
    let settled = false;
    let timedOut = false;
    let captured = "";
    if (onFailure) {
      const keep = (chunk) => {
        captured += chunk;
      };
      child.stdout?.setEncoding("utf8").on("data", keep);
      child.stderr?.setEncoding("utf8").on("data", keep);
    }

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
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      forceKillTimer.unref();
    }, timeoutMs);
    timeout.unref();

    child.once("exit", (code) => {
      finish(() => {
        if (timedOut) {
          onFailure?.(captured);
          reject(
            new Error(
              `${errorLabel} exceeded the ${timeoutMs}ms process timeout`
            )
          );
        } else if (code === 0) {
          resolve();
        } else {
          onFailure?.(captured);
          reject(new Error(`${errorLabel} exited ${code}`));
        }
      });
    });
    child.once("error", (error) => finish(() => reject(error)));
  });
}

export function spawnLive(cmd, args, options) {
  const { secrets: _secrets, ...rest } = options;
  return spawnWithTimeout(cmd, args, {
    ...rest,
    errorLabel: `${cmd} ${args.join(" ")}`,
    stdio: "inherit",
  });
}

const STEP_LINE =
  /(?:COMPLETED|FAILED|SKIPPED|PENDING)\s*$|^\s*(?:Element not found|Assertion is false)/u;

const FAILURE_TAIL = 12;

export function redactedSteps(output, secrets = []) {
  const scrubbed = secrets
    .filter((secret) => typeof secret === "string" && secret.length > 0)
    .reduce(
      (text, secret) => text.split(secret).join("«redacted»"),
      String(output)
    );
  return scrubbed
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "" && STEP_LINE.test(line))
    .slice(-FAILURE_TAIL);
}

export function spawnQuiet(cmd, args, options) {
  const { secrets = [], ...rest } = options;
  return spawnWithTimeout(cmd, args, {
    ...rest,
    errorLabel: `${cmd} sensitive flow`,
    stdio: ["ignore", "pipe", "pipe"],
    onFailure: (output) => {
      const steps = redactedSteps(output, secrets);
      if (steps.length === 0) return;
      console.error("  sensitive chunk failed at:");
      for (const step of steps) console.error(`    ${step}`);
    },
  });
}
