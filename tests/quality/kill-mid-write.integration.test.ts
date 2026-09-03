import { spawn } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  crashSchedule,
  resolveCrashIterations,
  resolveCrashSeed,
} from "./crash-schedule.js";
import type { CrashScheduleEntry } from "./crash-schedule.js";
import { CRASH_BOUNDARY_BY_ID } from "./fault-points.js";
import type { CrashBoundaryId } from "./fault-points.js";

interface RecoveryResult {
  readonly integrity: {
    readonly vault: { readonly integrity_check: string };
    readonly journal: { readonly integrity_check: string };
  };
  readonly observation: Record<string, unknown>;
  readonly strayTemps: readonly string[];
}

const EXPECTED_OBSERVATION: Record<CrashBoundaryId, Record<string, unknown>> = {
  "journal-after-append": { turns: 1, items: 1 },
  "blob-after-stage": { sessions: 1, received: 7, state: "open" },
  "wal-before-checkpoint": { items: 1 },
  "automation-after-claim": { conversations: 1, duplicateClaimAccepted: false },
};

const CHILD = path.join(
  import.meta.dirname,
  "fixtures/kill-mid-write-child.mjs"
);

function waitForFaultReady(
  child: ReturnType<typeof spawn>,
  faultPoint: CrashBoundaryId
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.stdout?.setEncoding("utf8");
    const onData = (chunk: string): void => {
      if (!chunk.includes(`FAULT_READY ${faultPoint}`)) return;
      child.stdout?.off("data", onData);
      resolve();
    };
    child.stdout?.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`fault gateway exited before injection (${code})`))
    );
  });
}

async function killAndRecover(
  dir: string,
  faultPoint: CrashBoundaryId
): Promise<RecoveryResult> {
  const child = spawn(process.execPath, [CHILD, dir, faultPoint], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  await waitForFaultReady(child, faultPoint);
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  const recovery = spawn(
    process.execPath,
    [CHILD, dir, faultPoint, "recover"],
    {
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  let output = "";
  recovery.stdout?.setEncoding("utf8");
  recovery.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    recovery.once("error", reject);
    recovery.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`recovery gateway exited ${code}`));
    });
  });
  const line = output
    .split("\n")
    .find((entry) => entry.startsWith("QUALITY_RECOVERY "));
  if (!line) throw new Error(`recovery emitted no result\n${output}`);
  return JSON.parse(line.slice("QUALITY_RECOVERY ".length)) as RecoveryResult;
}

const seed = resolveCrashSeed();
const iterations = resolveCrashIterations();
const schedule = crashSchedule(
  seed,
  iterations > 0 ? { mode: "sample", iterations } : { mode: "cover" }
);

describe("seeded crash-consistency lane", () => {
  test("crashSchedule replays byte-for-byte from its seed", () => {
    expect(crashSchedule(0x1234_5678)).toStrictEqual(
      crashSchedule(0x1234_5678)
    );
    expect(crashSchedule(0x1234_5678)).not.toStrictEqual(
      crashSchedule(0x8765_4321)
    );
    const sampled = crashSchedule(42, { mode: "sample", iterations: 12 });
    expect(sampled).toStrictEqual(
      crashSchedule(42, { mode: "sample", iterations: 12 })
    );
    expect(sampled).toHaveLength(12);
  });

  test.each(
    schedule.map((entry): [string, CrashScheduleEntry] => [
      `SIGKILL at ${entry.boundary} (seed 0x${entry.seed
        .toString(16)
        .padStart(8, "0")} step ${entry.step}) preserves acknowledged work`,
      entry,
    ])
  )("%s", async (_name, entry) => {
    const dir = await tempDir(`crash-${entry.boundary}-${entry.step}-`);
    const result = await killAndRecover(dir, entry.boundary);

    const boundary = CRASH_BOUNDARY_BY_ID[entry.boundary];
    expect(
      result.integrity.vault.integrity_check,
      `vault integrity after ${boundary.seam}`
    ).toBe("ok");
    expect(
      result.integrity.journal.integrity_check,
      `journal integrity after ${boundary.seam}`
    ).toBe("ok");
    expect(
      result.strayTemps,
      `orphaned temp files after ${boundary.seam}`
    ).toStrictEqual([]);
    expect(result.observation, boundary.invariant).toStrictEqual(
      EXPECTED_OBSERVATION[entry.boundary]
    );
  });
});
