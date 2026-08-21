import { describe, expect, test } from "vitest";

import {
  assertFloorsSubsetOfSeeds,
  buildScoresArtifact,
  enforceMutationFloors,
  loadMutationFloors,
  mutationScoreFromReport,
  MUTATION_GLOBAL_WATCH,
  MUTATION_SEEDS,
  selectAffectedSeeds,
} from "./run.mjs";

describe("mutationScoreFromReport", () => {
  test("reads top-level mutationScore", () => {
    expect(mutationScoreFromReport({ mutationScore: 82.5 })).toBe(82.5);
  });

  test("reads metrics.mutationScore", () => {
    expect(mutationScoreFromReport({ metrics: { mutationScore: 71 } })).toBe(
      71
    );
  });

  test("derives score from killed/totalValid", () => {
    expect(
      mutationScoreFromReport({ metrics: { killed: 8, totalValid: 10 } })
    ).toBe(80);
  });

  test("returns null for empty report", () => {
    expect(mutationScoreFromReport(null)).toBe(null);
    expect(mutationScoreFromReport({})).toBe(null);
  });

  test("derives score from Stryker 9 per-file mutants statuses", () => {
    expect(
      mutationScoreFromReport({
        files: {
          "a.ts": {
            mutants: [
              { status: "Killed" },
              { status: "Killed" },
              { status: "Survived" },
              { status: "Ignored" },
              { status: "NoCoverage" },
            ],
          },
        },
      })
    ).toBe(50); // 2 killed / (2 killed + 1 survived + 1 noCoverage)
  });
});

describe("MUTATION_SEEDS", () => {
  test("covers core property-defended packages with package-local configs", () => {
    expect(MUTATION_SEEDS.map((s) => s.id).sort()).toEqual(
      [
        "apps/oauth-worker",
        "packages/server/src/acp",
        "packages/server/src/engine",
        "packages/server/src/automation",
        "packages/backup",
        "packages/core/src/blob",
        "packages/blueprints",
        "packages/cli",
        "packages/client/src/replica",
        "packages/design",
        "packages/server",
        "packages/core/src/protocol",
        "packages/core/src/time",
        "packages/tunnel",
        "packages/vault",
        "packages/model-runtime",
        "packages/blueprints/apps/tasks",
        "packages/blueprints/apps/notes",
        "packages/blueprints/apps/agenda",
        "packages/blueprints/apps/_shared/pending-overlay",
        "packages/blueprints/apps/_shared/selection",
        "packages/blueprints/apps/_shared/triage",
        "packages/blueprints/apps/_shared/search-scaffold",
        "apps/mobile",
      ].sort()
    );
    for (const seed of MUTATION_SEEDS) {
      expect(seed.config).toMatch(
        /^stryker(?:\.[a-z]+(?:-[a-z]+)*)?\.config\.mjs$/u
      );
      expect(
        seed.cwd.startsWith("packages/") || seed.cwd.startsWith("apps/"),
        seed.id
      ).toBe(true);
      expect(seed.report.startsWith("artifacts/mutation/")).toBe(true);
    }
  });

  test("every seed watches its own config pair, and every id is unique", () => {
    // #545 A5 makes a missing score a gate failure, so a seed whose watch list
    // omits its own config would go stale without the PR lane noticing.
    const ids = MUTATION_SEEDS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const labels = MUTATION_SEEDS.map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const seed of MUTATION_SEEDS) {
      expect(seed.watch, seed.id).toContain(`${seed.cwd}/${seed.config}`);
      expect(
        seed.watch.some((file) =>
          /vitest\..*mutation\.config\.ts$/u.test(file)
        ),
        seed.id
      ).toBe(true);
      expect(seed.report, seed.id).toBe(
        `artifacts/mutation/${seed.label}-report.json`
      );
    }
  });

  test("every seed has a floor and every floor names a seed", () => {
    // The weakness gate (`_absoluteWeaknessBelow`) and the matrix computation
    // both read floors ∪ scores by id; an unpaired entry on either side is a
    // silent hole.
    const floors = loadMutationFloors();
    expect(assertFloorsSubsetOfSeeds(floors)).toStrictEqual([]);
    for (const seed of MUTATION_SEEDS) {
      expect(typeof floors[seed.id], seed.id).toBe("number");
    }
    expect(typeof floors._absoluteWeaknessBelow).toBe("number");
  });
});

describe("buildScoresArtifact", () => {
  test("wraps package rows for the test-health report path", () => {
    const artifact = buildScoresArtifact([
      { id: "packages/vault", label: "vault", score: 80, status: "ok" },
    ]);
    expect(artifact.lane).toBe("mutation");
    expect(artifact.packages).toHaveLength(1);
    expect(artifact.generatedAt).toMatch(/^\d{4}-/u);
  });
});

describe("selectAffectedSeeds", () => {
  test("returns only seeds whose watch paths appear in the diff", () => {
    const hit = selectAffectedSeeds([
      "packages/core/src/protocol/handshake.ts",
    ]);
    expect(hit.map((s) => s.label)).toEqual(["protocol"]);
  });

  test("global watch forces every seed", () => {
    expect(MUTATION_GLOBAL_WATCH).toContain("tests/mutation-floors.json");
    const hit = selectAffectedSeeds(["tests/mutation-floors.json"]);
    expect(hit).toHaveLength(MUTATION_SEEDS.length);
  });

  test("unrelated paths select nothing", () => {
    expect(selectAffectedSeeds(["README.md", "apps/web/src/main.tsx"])).toEqual(
      []
    );
  });
});

describe("enforceMutationFloors", () => {
  test("fails when measured score is below floor", () => {
    expect(
      enforceMutationFloors(
        {
          packages: [{ id: "packages/vault", score: 90 }],
        },
        { "packages/vault": 97 }
      )
    ).toEqual([
      'mutation floor "packages/vault" not met: measured 90.00 < floor 97',
    ]);
  });

  test("passes when score meets floor", () => {
    expect(
      enforceMutationFloors(
        {
          packages: [{ id: "packages/vault", score: 97 }],
        },
        { "packages/vault": 97 }
      )
    ).toEqual([]);
  });

  test("fails when a floored seed has no measured score (#545 A5)", () => {
    expect(
      enforceMutationFloors(
        {
          packages: [
            { id: "packages/vault", score: 97 },
            { id: "packages/backup", score: null },
          ],
        },
        { "packages/vault": 97, "packages/backup": 42 }
      )
    ).toEqual([
      'mutation floor "packages/backup" has no measured score (seed missing, crashed, or skipped)',
    ]);
  });

  test("fails when floor id is absent from scores entirely", () => {
    expect(
      enforceMutationFloors(
        { packages: [{ id: "packages/vault", score: 99 }] },
        {
          "packages/vault": 97,
          "packages/ghost": 50,
        }
      )
    ).toEqual([
      'mutation floor "packages/ghost" has no measured score (seed missing, crashed, or skipped)',
    ]);
  });
});

describe("assertFloorsSubsetOfSeeds", () => {
  test("fails when a floor id is not in MUTATION_SEEDS", () => {
    const errors = assertFloorsSubsetOfSeeds({
      "packages/vault": 97,
      "packages/not-a-seed": 50,
    });
    expect(errors.some((e) => e.includes("packages/not-a-seed"))).toBe(true);
  });

  test("passes when every numeric floor is a known seed id", () => {
    const floors = Object.fromEntries(MUTATION_SEEDS.map((s) => [s.id, 50]));
    expect(assertFloorsSubsetOfSeeds(floors)).toEqual([]);
  });
});
