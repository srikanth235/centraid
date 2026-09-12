/*
 * Spawning, supervising and OWNING the `centraid seat` sidecar
 * (#1020, D-1020-F1). The arithmetic is `sidecar-supervisor-core.ts`; this file
 * is `child_process`, `fs` and the clock.
 *
 * Three v0 traps carried, one product decision changed:
 *
 * - **`stdio` is piped and logged, never `ignore`** (census §F seam 3). The
 *   child's stderr is the only place its real failure reason exists, and the
 *   crash-loop screen quotes it.
 * - **The ready line is the contract.** `centraid seat ready …` on stdout, the
 *   same shape the gateway prints, rather than polling for a socket that might
 *   be somebody else's (census §F2's 30-second ready-poll-against-a-stranger).
 * - **Termination is awaited before the socket path is reused** (§F seam 2).
 * - **Quit stops it.** v0 leaves a detached gateway running on purpose; a seat
 *   process whose only client is this window is owned — see `quitSequence`.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

import {
  backoffForAttempt,
  classifyExit,
  crashLoopMessage,
  initialSupervisorState,
  mayRevive,
  quitSequence,
  recordFailure,
  recordSuccess,
  TERMINATE_GRACE_MS,
} from "./sidecar-supervisor-core.js";
import type {
  RevivalBudget,
  SupervisorState,
} from "./sidecar-supervisor-core.js";

/** The line the sidecar prints when its door is open. */
export const READY_LINE = "centraid seat ready";

/** How much of the child's stderr the crash log keeps. */
const STDERR_TAIL_BYTES = 8 * 1024;

export interface SidecarOptions {
  /** The `centraid` binary. */
  binary: string;
  dataDir: string;
  socketPath: string;
  thin: boolean;
  /** Where the nonce file is written. Inside `userData`, mode 0600. */
  nonceFile: string;
  log: (line: string) => void;
}

export interface Sidecar {
  pid: number | undefined;
  nonce: string;
  mode: "replicated" | "thin";
  /** The ready line, verbatim, for the diagnostics screen. */
  readyLine: string;
  alive: () => boolean;
  stderrTail: () => string;
  /** Wait for the process to exit, at most `ms`. */
  waitForExit: (ms: number) => Promise<boolean>;
  signal: (which: "SIGTERM" | "SIGKILL") => void;
}

/**
 * A fresh instance nonce, written to a 0600 file.
 *
 * A FILE AND NOT A FLAG OR AN ENV VAR: a flag is in every `ps` listing on the
 * host and an env var is in `/proc/<pid>/environ`. The nonce is an instance
 * binding rather than a secret — the socket's mode and the peer check are the
 * credential — but the cheap thing is also the right thing here, and the
 * sidecar accepts `--nonce-file` for exactly this reason.
 */
export function writeNonce(nonceFile: string): string {
  const nonce = Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
  fs.mkdirSync(path.dirname(nonceFile), { recursive: true });
  fs.writeFileSync(nonceFile, nonce, { mode: 0o600 });
  // `writeFileSync`'s mode is only applied when the file is CREATED, so an
  // existing file keeps whatever mode it had. Set it explicitly.
  fs.chmodSync(nonceFile, 0o600);
  return nonce;
}

/** Spawn the sidecar and wait for its ready line. */
export function spawnSidecar(options: SidecarOptions): Promise<Sidecar> {
  const nonce = writeNonce(options.nonceFile);
  const args = [
    "seat",
    "--data-dir",
    options.dataDir,
    "--socket",
    options.socketPath,
    "--nonce-file",
    options.nonceFile,
    ...(options.thin ? ["--thin"] : []),
  ];
  options.log(`[sidecar] ${options.binary} ${args.join(" ")}`);
  const child = spawn(options.binary, args, {
    // PIPED, never `ignore`. See the header.
    stdio: ["ignore", "pipe", "pipe"],
    // NOT detached: this process is owned, and a detached child would outlive
    // a crashed shell with the vault's write lock held.
    detached: false,
    env: {
      ...process.env,
      // The stale-artifact refusal the gateway already honours: the shell says
      // which core digest it was built against, and a mismatched sidecar
      // refuses before it answers one query (D-1020-G2).
      ...(process.env["CENTRAID_EXPECTED_CORE_DIGEST"]
        ? {
            CENTRAID_EXPECTED_CORE_DIGEST:
              process.env["CENTRAID_EXPECTED_CORE_DIGEST"],
          }
        : {}),
    },
  }) as ChildProcessByStdio<null, Readable, Readable>;

  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    for (const line of chunk.split("\n")) {
      if (line.trim()) options.log(`[sidecar:err] ${line}`);
    }
  });

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  const exitWaiters: Array<() => void> = [];
  child.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
    const classified = classifyExit({ code, signal, stderrTail });
    options.log(`[sidecar] exited (${classified.kind}): ${classified.detail}`);
    for (const waiter of exitWaiters.splice(0)) waiter();
  });

  const sidecar: Sidecar = {
    pid: child.pid,
    nonce,
    mode: options.thin ? "thin" : "replicated",
    readyLine: "",
    alive: () => !exited,
    stderrTail: () => stderrTail,
    waitForExit: async (ms) => {
      if (exited) return true;
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (exitedInTime: boolean): void => {
          if (settled) return;
          settled = true;
          resolve(exitedInTime);
        };
        const timer = setTimeout(() => settle(false), ms);
        exitWaiters.push(() => {
          clearTimeout(timer);
          settle(true);
        });
      });
    },
    signal: (which) => {
      if (exited) return;
      try {
        // A BARE PID, not a process group. v0 signals `-pid` because its child
        // is `detached` and owns a group; this one is not detached, so `-pid`
        // would be a signal to the SHELL's own group — which is how a quit
        // becomes a kill of the window.
        child.kill(which);
      } catch (error) {
        options.log(`[sidecar] could not signal: ${String(error)}`);
      }
    },
  };

  return new Promise<Sidecar>((resolve, reject) => {
    let settled = false;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (settled || newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith(READY_LINE)) return;
      settled = true;
      clearTimeout(deadline);
      sidecar.readyLine = line;
      options.log(`[sidecar] ${line}`);
      resolve(sidecar);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      reject(new Error(`the seat binary would not start: ${error.message}`));
    });
    child.on("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      const classified = classifyExit({
        code: exitCode,
        signal: exitSignal,
        stderrTail,
      });
      // The child's OWN reason, which only exists because stdio is piped.
      reject(new Error(`the seat did not start: ${classified.detail}`));
    });
    // Thirty seconds, as v0's ready poll. A sidecar that has not printed its
    // ready line by then is wedged, and waiting longer only delays the screen
    // that says so.
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `the seat did not print its ready line within 30s. Last stderr: ${stderrTail
            .trim()
            .split("\n")
            .slice(-2)
            .join(" ")}`
        )
      );
    }, 30_000);
  });
}

/** What the supervisor is holding. */
export interface SupervisedSeat {
  sidecar: Sidecar;
  /** Set once a connection has been established over the socket. */
  attached: boolean;
}

/**
 * The supervisor: one seat at a time, with v0's budgets.
 *
 * `disposed` is set FIRST on quit, so a mid-teardown retry cannot resurrect a
 * closing seat — v0's `markLocalGatewaysDisposed()` ordering
 * (`main.ts:180`–`:182`), which is a bug it had before it was a rule.
 */
export function createSupervisor(options: {
  start: () => Promise<SupervisedSeat>;
  /** Called with the terminal command when a seat must stop cleanly. */
  terminate: (seat: SupervisedSeat) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  onCrashLoop: (message: string) => void;
}) {
  let state: SupervisorState = initialSupervisorState();
  let budget: RevivalBudget | undefined;
  let current: SupervisedSeat | undefined;
  let starting: Promise<SupervisedSeat> | undefined;
  let disposed = false;
  let lastManualRetryAt: number | undefined;

  const ensure = async (): Promise<SupervisedSeat> => {
    if (disposed) throw new Error("the shell is quitting");
    if (current?.sidecar.alive()) return current;
    // A press inside an in-flight start JOINS it rather than starting a second
    // seat — v0's manual-retry rule, and here it also prevents two writers.
    if (starting) return starting;
    if (state.loopBroken) throw new Error(crashLoopMessage(state));
    const attempt = (async () => {
      try {
        const seat = await options.start();
        state = recordSuccess();
        current = seat;
        return seat;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state = recordFailure(state, options.now(), message);
        options.log(
          `[supervisor] start failed (attempt ${state.attempt}, next backoff ${backoffForAttempt(
            state.attempt
          )}ms): ${message}`
        );
        if (state.loopBroken) options.onCrashLoop(crashLoopMessage(state));
        throw error;
      } finally {
        starting = undefined;
      }
    })();
    starting = attempt;
    return attempt;
  };

  return {
    ensure,
    current: () => current,
    failure: () =>
      state.loopBroken
        ? { loopBroken: true as const, message: crashLoopMessage(state) }
        : state.lastError
          ? { loopBroken: false as const, message: state.lastError }
          : undefined,
    /** "Try again": clears the automatic budgets, keeps a one-press floor. */
    retry: async (): Promise<SupervisedSeat> => {
      const now = options.now();
      if (
        lastManualRetryAt !== undefined &&
        now - lastManualRetryAt < 3000 &&
        starting
      ) {
        return starting;
      }
      lastManualRetryAt = now;
      state = initialSupervisorState();
      budget = undefined;
      return ensure();
    },
    /** A seat that died after a clean start. */
    revive: async (): Promise<SupervisedSeat | undefined> => {
      const judged = mayRevive({
        owned: true,
        processGone: !(current?.sidecar.alive() ?? false),
        quitting: disposed,
        budget,
        now: options.now(),
      });
      budget = judged.next;
      if (!judged.allowed) {
        options.log(
          `[supervisor] not reviving: ${judged.why ?? "no reason given"}`
        );
        return undefined;
      }
      current = undefined;
      return ensure();
    },
    /**
     * The quit path, in the order `quitSequence` names. Every step is taken
     * here and the list is asserted there, so the ordering is tested without
     * a window.
     */
    shutdown: async (): Promise<string[]> => {
      const taken: string[] = [];
      const seat = current;
      // ONE STEP AT A TIME, and `Promise.all` would be wrong rather than
      // faster: the ordering IS the ruling (D-1020-F1) — the seat's `closing`
      // must land before `SIGTERM`, and the exit must be awaited before the
      // socket path is reusable. `quitSequence`'s test asserts the order; this
      // loop takes the steps in it.
      for (const step of quitSequence({
        attached: seat?.attached ?? false,
        processAlive: seat?.sidecar.alive() ?? false,
      })) {
        taken.push(step.step);
        switch (step.step) {
          case "dispose":
            disposed = true;
            break;
          case "terminate-command":
          case "await-close":
            if (step.step === "terminate-command" && seat) {
              // One call covers both steps: the terminal command's answer IS
              // the seat's `closing`, and awaiting it is the point.
              // oxlint-disable-next-line no-await-in-loop
              await options.terminate(seat).catch((error: unknown) => {
                options.log(
                  `[supervisor] the terminal command failed: ${String(error)}`
                );
              });
            }
            break;
          case "sigterm":
            seat?.sidecar.signal("SIGTERM");
            break;
          case "wait":
            // oxlint-disable-next-line no-await-in-loop
            if (seat && !(await seat.sidecar.waitForExit(step.ms))) {
              options.log(
                `[supervisor] the seat did not exit in ${TERMINATE_GRACE_MS}ms; escalating`
              );
            }
            break;
          case "sigkill":
            if (seat?.sidecar.alive()) seat.sidecar.signal("SIGKILL");
            break;
          case "await-exit":
            // AWAITED. Nothing may reuse the socket path until this resolves.
            // oxlint-disable-next-line no-await-in-loop
            await seat?.sidecar.waitForExit(2000);
            break;
          case "unlink-socket":
            break;
        }
      }
      current = undefined;
      return taken;
    },
  };
}
