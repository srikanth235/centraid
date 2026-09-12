/**
 * Fuzz crasher replay suite (#839 G10).
 *
 * The fuzz lane is a search; this is its memory. Every input that ever violated
 * an invariant is committed under `scripts/fuzz/crashers/<target>/` and replayed
 * here as an ordinary test, so a defect that has been found once cannot come
 * back quietly — including the ones we have deliberately not fixed yet.
 *
 * Two directions, decided by `scripts/fuzz/known-findings.json`:
 *
 * - Class **registered** (a recorded, unfixed defect): the replay pins the
 *   finding's exact class and message. It is a characterisation test. The day
 *   the product changes — fixed, or made worse — this suite goes red and the
 *   register entry has to be revisited on purpose.
 * - Class **not registered** (the defect was fixed and its entry removed): the
 *   replay asserts the input now runs clean. That is the regression lock.
 *
 * The suite also replays the whole committed seed corpus and re-runs one target
 * twice at a fixed seed, which is what makes "deterministic" a tested claim
 * rather than a design note.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFuzzArtifact,
  fuzzTarget,
  inputDigest,
  loadCorpus,
  loadKnownFindings,
  partitionFindings,
} from "./run.ts";
import { FUZZ_TARGETS, FuzzInvariantError, targetById } from "./targets.ts";

const fuzzDir = import.meta.dirname;
const crashersDir = path.join(fuzzDir, "crashers");

/**
 * Every committed crasher, newest-first-agnostic (name-sorted for stability).
 * @returns {{ file: string; record: Record<string, unknown> }[]} Crasher records.
 */
type CrasherRecord = {
  inputBase64: string;
  inputDigest: string;
  target: string;
  class: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asCrasher(value: unknown, file: string): CrasherRecord {
  if (
    !isRecord(value) ||
    typeof value.inputBase64 !== "string" ||
    typeof value.inputDigest !== "string" ||
    typeof value.target !== "string" ||
    typeof value.class !== "string" ||
    typeof value.message !== "string"
  ) {
    throw new Error(`invalid crasher record ${file}`);
  }
  return {
    inputBase64: value.inputBase64,
    inputDigest: value.inputDigest,
    target: value.target,
    class: value.class,
    message: value.message,
  };
}

function committedCrashers(): { file: string; record: CrasherRecord }[] {
  if (!existsSync(crashersDir)) return [];
  return readdirSync(crashersDir)
    .sort()
    .flatMap((targetId) =>
      readdirSync(path.join(crashersDir, targetId))
        .sort()
        .filter((name) => name.endsWith(".json"))
        .map((name) => {
          const file = `${targetId}/${name}`;
          const parsed: unknown = JSON.parse(
            readFileSync(path.join(crashersDir, targetId, name), "utf8")
          );
          return { file, record: asCrasher(parsed, file) };
        })
    );
}

const crashers = committedCrashers();
const known = loadKnownFindings();

/**
 * Run one target's entry once over a single input.
 * @param {string} targetId Target id.
 * @param {Uint8Array} bytes Input.
 * @returns {Promise<{ ok: boolean; className?: string; message?: string }>} Outcome.
 */
async function replayOnce(
  targetId: string,
  bytes: Uint8Array
): Promise<{ ok: boolean; className?: string; message?: string }> {
  const run = await targetById(targetId).load();
  try {
    run(bytes);
    return { ok: true };
  } catch (error) {
    // Boundary: this IS the observation the suite exists to record.
    if (error instanceof FuzzInvariantError)
      return { ok: false, className: error.className, message: error.message };
    return {
      ok: false,
      className: `uncaught.${error instanceof Error ? error.name : typeof error}`,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("fuzz crasher replay", () => {
  it("has at least one committed crasher to replay", () => {
    // A harness with an empty crasher corpus proves nothing. If this ever fails
    // because every finding was fixed, delete it with the last register entry.
    expect(crashers.length).toBeGreaterThan(0);
  });

  it.each(crashers)("replays $file", async ({ record }) => {
    const bytes = Buffer.from(record.inputBase64, "base64");
    expect(inputDigest(bytes)).toBe(record.inputDigest);
    const outcome = await replayOnce(record.target, bytes);
    const registered = known.classes[record.class];
    // Recorded defects pin class+message; fixed defects must now be uneventful.
    const observed = registered
      ? { class: outcome.className, message: outcome.message }
      : outcome;
    const expected = registered
      ? { class: record.class, message: record.message }
      : { ok: true };
    expect(observed).toStrictEqual(expected);
  });

  it("backs every registered finding with a committed crasher", () => {
    const withCrashers = new Set(crashers.map(({ record }) => record.class));
    expect(
      Object.keys(known.classes).filter((name) => !withCrashers.has(name))
    ).toStrictEqual([]);
  });

  it("registers every committed crasher or proves it fixed", async () => {
    // A crasher file whose class left the register must be a *fixed* defect,
    // not a forgotten one — `replays $file` above is what proves that, so this
    // only guards the shape: no crasher may name a target that no longer exists.
    const ids = new Set(FUZZ_TARGETS.map((target) => target.id));
    expect(
      crashers.map(({ record }) => record.target).filter((id) => !ids.has(id))
    ).toStrictEqual([]);
  });
});

describe("fuzz seed corpus", () => {
  it.each(FUZZ_TARGETS.map((target) => target.id))(
    "%s seed corpus violates no unregistered invariant",
    async (targetId) => {
      const target = targetById(targetId);
      const row = await fuzzTarget(target, {
        seed: 839_001,
        iterations: loadCorpus(targetId).length,
        timeBudgetMs: 60_000,
      });
      const { fresh } = partitionFindings([row], known);
      expect(fresh.map((finding) => finding.className)).toStrictEqual([]);
    }
  );
});

describe("fuzz determinism", () => {
  it("produces an identical program for one seed", async () => {
    const target = targetById("wal-keys");
    const options = { seed: 839_007, iterations: 4_000, timeBudgetMs: 60_000 };
    const [first, second] = [
      await fuzzTarget(target, options),
      await fuzzTarget(target, options),
    ];
    // Timings are the only thing allowed to differ between two runs.
    const stable = (row: { elapsedMs: number; execPerSecond: number }) => ({
      ...row,
      elapsedMs: 0,
      execPerSecond: 0,
    });
    expect(stable(second)).toStrictEqual(stable(first));
    expect(second.executions).toBe(options.iterations);
  });

  it("keeps the artifact shape the report lane reads", async () => {
    const artifact = buildFuzzArtifact([], { seed: 1, mode: "smoke" });
    expect(Object.keys(artifact).sort()).toStrictEqual([
      "generatedAt",
      "lane",
      "mode",
      "seed",
      "targets",
    ]);
    expect(artifact.lane).toBe("fuzz");
  });
});
