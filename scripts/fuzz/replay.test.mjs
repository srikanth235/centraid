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
} from "./run.mjs";
import { FUZZ_TARGETS, FuzzInvariantError, targetById } from "./targets.mjs";

const fuzzDir = import.meta.dirname;
const crashersDir = path.join(fuzzDir, "crashers");

function committedCrashers() {
  if (!existsSync(crashersDir)) return [];
  return readdirSync(crashersDir)
    .sort()
    .flatMap((targetId) =>
      readdirSync(path.join(crashersDir, targetId))
        .sort()
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({
          file: `${targetId}/${name}`,
          record: JSON.parse(
            readFileSync(path.join(crashersDir, targetId, name), "utf8")
          ),
        }))
    );
}

const crashers = committedCrashers();
const known = loadKnownFindings();

async function replayOnce(targetId, bytes) {
  const run = await targetById(targetId).load();
  try {
    run(bytes);
    return { ok: true };
  } catch (error) {
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
    expect(crashers.length).toBeGreaterThan(0);
  });

  it.each(crashers)("replays $file", async ({ record }) => {
    const bytes = Buffer.from(record.inputBase64, "base64");
    expect(inputDigest(bytes)).toBe(record.inputDigest);
    const outcome = await replayOnce(record.target, bytes);
    const registered = known.classes[record.class];
    if (registered) {
      expect({ class: outcome.className, message: outcome.message }).toEqual({
        class: record.class,
        message: record.message,
      });
    } else {
      expect(outcome).toEqual({ ok: true });
    }
  });

  it("backs every registered finding with a committed crasher", () => {
    const withCrashers = new Set(crashers.map(({ record }) => record.class));
    expect(
      Object.keys(known.classes).filter((name) => !withCrashers.has(name))
    ).toEqual([]);
  });

  it("registers every committed crasher or proves it fixed", async () => {
    const ids = new Set(FUZZ_TARGETS.map((target) => target.id));
    expect(
      crashers.map(({ record }) => record.target).filter((id) => !ids.has(id))
    ).toEqual([]);
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
      expect(fresh.map((finding) => finding.className)).toEqual([]);
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
    const stable = (row) => ({ ...row, elapsedMs: 0, execPerSecond: 0 });
    expect(stable(second)).toEqual(stable(first));
    expect(second.executions).toBe(options.iterations);
  });

  it("keeps the artifact shape the report lane reads", async () => {
    const artifact = buildFuzzArtifact([], { seed: 1, mode: "smoke" });
    expect(Object.keys(artifact).sort()).toEqual([
      "generatedAt",
      "lane",
      "mode",
      "seed",
      "targets",
    ]);
    expect(artifact.lane).toBe("fuzz");
  });
});
