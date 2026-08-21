import { describe, expect, test } from "vitest";

import {
  appAxesFor,
  baseMatrix,
  makeFixtureRoot,
  OWNER,
  runGenerate,
} from "./report-fixture-root.mjs";

/**
 * #839 Wave 0 — grids B and D. Their cells are DECLARATIONS, not evidence, so
 * the contract is: they render, they carry their citation, and they change
 * nothing about cell health — the nightly zero-grey contract must not move
 * because a seat or a state has no owner yet.
 */
describe("app × seat and app × designed state grids", () => {
  /** A fixture bundling one app, with one owned seat and one held seat. */
  function axesMatrix() {
    const axes = appAxesFor(["locker"], ["dayone", "denied"]);
    axes.appSeats.apps[0].seats.custodian = {
      status: "owned",
      owner: OWNER,
      tier: "e2e",
    };
    axes.appSeats.apps[0].seats.viewer = {
      status: "skip",
      reason: "Locker declares seats.disabledOn viewer.",
      citation: "docs/blueprint-seats.md#the-three-seats",
    };
    axes.appStates.apps[0].states.denied = { status: "owned", owner: OWNER };
    return {
      ...baseMatrix(),
      ...axes,
      appEngines: {
        seatDoctrine: "docs/blueprint-seats.md#engine-contracts",
        engines: [],
        apps: [{ id: "locker", engines: {} }],
      },
    };
  }

  test("renders both grids, with owners declared and gaps citing their issue", () => {
    const root = makeFixtureRoot({
      matrix: axesMatrix(),
      appManifestStates: { designed: ["dayone", "denied"], excluded: [] },
    });
    const result = runGenerate(root);
    expect(result.status).toBe(0);
    expect(result.html).toContain("Blueprint app × seat");
    expect(result.html).toContain("Blueprint app × designed state");
    // A declared owner is neutral, never the green that means "evidence ran".
    expect(result.html).toContain('class="metric axis-declared"');
    expect(result.html).toContain('class="metric axis-unowned"');
    expect(result.html).toContain("Locker declares seats.disabledOn viewer.");
    expect(result.html).toContain("no seat owner yet — tracked by #839");
    expect(result.html).toContain("no owner yet — tracked by #839");
  });

  test("counts the declarations without touching cell health", () => {
    const root = makeFixtureRoot({
      matrix: axesMatrix(),
      appManifestStates: { designed: ["dayone", "denied"], excluded: [] },
    });
    const withGrids = runGenerate(root);
    expect(withGrids.summary.appSeatCells).toEqual({
      declared: 1,
      unowned: 1,
      skipped: 1,
    });
    expect(withGrids.summary.appStateCells).toEqual({
      declared: 1,
      unowned: 1,
      skipped: 0,
    });
    // The same run with no app axes at all reports identical cell health: the
    // grids are additive reporting, never an input to the zero-grey contract.
    const plain = runGenerate(makeFixtureRoot());
    expect(withGrids.summary.cellsMissing).toBe(plain.summary.cellsMissing);
    expect(withGrids.summary.cellsExpectedGrey).toBe(
      plain.summary.cellsExpectedGrey
    );
    expect(withGrids.summary.missingCellIds).toEqual(
      plain.summary.missingCellIds
    );
  });

  test("an excluded state renders as a structural exclusion, not a gap", () => {
    const matrix = axesMatrix();
    matrix.appStates.apps[0].states.denied = { status: "excluded" };
    const root = makeFixtureRoot({
      matrix,
      appManifestStates: {
        designed: ["dayone"],
        excluded: [
          { state: "denied", reason: "no read path", citation: "docs/x.md" },
        ],
      },
    });
    const result = runGenerate(root);
    expect(result.status).toBe(0);
    expect(result.html).toContain(
      "structurally excluded by this app's manifest"
    );
    expect(result.summary.appStateCells.skipped).toBe(1);
  });
});
