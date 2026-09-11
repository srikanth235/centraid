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
    // Only ever populated when the caller asked for pipes. Held in memory
    // rather than written anywhere: for a sensitive chunk this buffer holds
    // whatever Maestro echoed, and only `onFailure` decides what may be said.
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
      // Maestro is a JVM process and can be stuck below its JS caller. Give it
      // one normal shutdown window, then guarantee the chunk actually ends.
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
  // `secrets` is dropped rather than forwarded: a non-sensitive chunk has none
  // to redact, and passing an unknown key through to `spawn()` is noise.
  const { secrets: _secrets, ...rest } = options;
  return spawnWithTimeout(cmd, args, {
    ...rest,
    errorLabel: `${cmd} ${args.join(" ")}`,
    stdio: "inherit",
  });
}

/**
 * Maestro prints one line per directive. These are the shapes that say WHICH
 * directive was reached and what became of it — the whole diagnosis for a
 * chunk, and never a value: a directive line carries the selector and the
 * verb, while `inputText` renders as the `${MAESTRO_*}` placeholder because
 * that is literally what the retained YAML contains.
 */
const STEP_LINE =
  /(?:COMPLETED|FAILED|SKIPPED|PENDING)\s*$|^\s*(?:Element not found|Assertion is false)/u;

/** How many trailing step lines a failure gets to explain itself. Enough for
 *  the failed directive and the ones around it; short enough that it cannot
 *  become a dump. */
const FAILURE_TAIL = 12;

/**
 * Everything a sensitive chunk is allowed to say about its own failure.
 *
 * TWO independent controls, because one of them being wrong must not be enough
 * (the repo's belt-and-braces rule for capability handling):
 *   1. only lines matching `STEP_LINE` survive — a directive name, never a value;
 *   2. every secret is replaced by exact-string match anyway, so a value that
 *      somehow reached a step line still cannot be printed.
 */
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

/**
 * Run a chunk whose ARGUMENTS carry a live enrollment capability.
 *
 * It used to run `stdio: "ignore"`, which kept the capability out of the log by
 * keeping EVERYTHING out of it. That is why `pairing-canary` — the PR gate's
 * short-circuiting prerequisite, which takes the other four journeys down with
 * it — could fail twice in four runs and name nothing either time: once at 73s
 * and once at 125s, two different sub-failures inside `01-configure-gateway`,
 * both reported as `maestro sensitive flow exited 1` (#905).
 *
 * Output is now captured and, ON FAILURE ONLY, the redacted step lines are
 * printed. A green run's output is unchanged — still silent. The capability
 * itself is no more printable than before; what changed is that a failure says
 * which directive it died on.
 */
export function spawnQuiet(cmd, args, options) {
  const { secrets = [], ...rest } = options;
  return spawnWithTimeout(cmd, args, {
    ...rest,
    // Still never the command arguments: the ticket is one of them.
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
