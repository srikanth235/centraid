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
    // A declared owner is neutral, never the green that means "evidence ran" —
    // and since #862 the register says which it is in WORDS, with the tint only
    // the second reading. Class and word are pinned together because either
    // alone survives the other being dropped: a cell that keeps its tint but
    // loses its text is exactly the unreadable grid the restructure removed.
    expect(result.html).toMatch(/class="cell axis-declared"[^>]*>owned</u);
    // "no owner" rather than "unowned": the app grids and §8 say one word for
    // one fact since #864, and wear one treatment for it.
    expect(result.html).toMatch(/class="cell axis-unowned"[^>]*>no owner</u);
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

  test("a held state renders with its citation, never as silence", () => {
    const matrix = axesMatrix();
    matrix.trackingIssues[831] = {
      url: "https://example.invalid/831",
      state: "closed",
    };
    matrix.appStates.apps[0].states.dayone = {
      status: "held",
      citation: "#831",
    };
    const root = makeFixtureRoot({
      matrix,
      appManifestStates: { designed: ["dayone", "denied"], excluded: [] },
    });
    const result = runGenerate(root);
    expect(result.status).toBe(0);
    // The cell is neutral like a skip — a held interface is not a gap — but it
    // carries the ruling that held it, in the cell and in its tooltip.
    expect(result.html).toContain(
      "designed, but held with the interface pending #831"
    );
    // The cell's own text and its citation badge, in one match: the word says
    // the seat is not taken and the badge says which ruling held it. A held
    // cell that renders one without the other is the silence this forbids.
    expect(result.html).toMatch(
      /class="cell axis-skipped"[^>]*>n\/a<small>#831<\/small>/u
    );
    // Counted, not dropped: a held cell is never missing from the tally.
    expect(result.summary.appStateCells).toEqual({
      declared: 1,
      unowned: 0,
      skipped: 1,
    });
    // And it changes nothing about cell health.
    const plain = runGenerate(makeFixtureRoot());
    expect(result.summary.cellsMissing).toBe(plain.summary.cellsMissing);
    expect(result.summary.cellsExpectedGrey).toBe(
      plain.summary.cellsExpectedGrey
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
