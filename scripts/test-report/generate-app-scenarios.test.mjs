import { describe, expect, test } from "vitest";

import {
  buildAppScenarioGrid,
  countScenarioCells,
  scenarioGridIsZeroGrey,
} from "./app-scenario-grid.mjs";
import {
  appAxesFor,
  baseMatrix,
  makeFixtureRoot,
  OWNER,
  runGenerate,
} from "./report-fixture-root.mjs";

/**
 * #864 Wave 7 — per-app scenario grids. Declarations, not health: owned is
 * never green, gap is the plum "no owner", product-bug is indigo, and the
 * grid may not paint an absence grey.
 */
describe("per-app scenario grids", () => {
  function scenariosMatrix() {
    const axes = appAxesFor(["locker"], ["dayone"]);
    return {
      ...baseMatrix(),
      ...axes,
      appEngines: {
        seatDoctrine: "docs/blueprint-seats.md#engine-contracts",
        engines: [],
        apps: [{ id: "locker", engines: {} }],
      },
      appScenarios: {
        trackingIssue: "839",
        layers: [
          { id: "unit", label: "U" },
          { id: "component", label: "C" },
          { id: "journey", label: "E" },
        ],
        apps: [
          {
            id: "locker",
            doc: "docs/apps/locker-scenarios.md",
            scenarios: [
              {
                id: "totp",
                label: "TOTP generation",
                layer: "unit",
                status: "owned",
                owner: OWNER,
              },
              {
                id: "gate",
                label: "gate origin journey",
                layer: "journey",
                status: "gap",
                trackingIssue: "839",
              },
              {
                id: "pin-empty",
                label: "Pin keeps the body",
                layer: "component",
                status: "product-bug",
                trackingIssue: "839",
                note: "in-editor write overwrites the body with empty",
              },
            ],
          },
        ],
      },
    };
  }

  test("renders one table per app, with owned, no owner, and product bug distinct", () => {
    const root = makeFixtureRoot({
      matrix: scenariosMatrix(),
      appManifestStates: { designed: ["dayone"], excluded: [] },
    });
    const result = runGenerate(root);
    expect(result.status).toBe(0);
    expect(result.html).toContain("Scenarios · per-app verb ledger");
    expect(result.html).toContain("scenario-app");
    expect(result.html).toContain("TOTP generation");
    expect(result.html).toMatch(/class="cell axis-declared"[^>]*>owned</u);
    expect(result.html).toMatch(/class="cell axis-unowned"[^>]*>no owner</u);
    expect(result.html).toMatch(/class="cell axis-bug"[^>]*>product bug</u);
    expect(result.html).toContain(
      "in-editor write overwrites the body with empty"
    );
    expect(result.html).toMatch(/<b class="cell axis-bug">product bug<\/b>/u);
  });

  test("extends zero-grey: the scenario grid never paints an absence grey", () => {
    const grid = buildAppScenarioGrid(scenariosMatrix());
    expect(scenarioGridIsZeroGrey(grid)).toBe(true);
    const root = makeFixtureRoot({
      matrix: scenariosMatrix(),
      appManifestStates: { designed: ["dayone"], excluded: [] },
    });
    const result = runGenerate(root);
    const section =
      result.html.split('id="scenarios"')[1]?.split("<h2")[0] ?? "";
    expect(section).not.toMatch(
      /class="cell (?:missing|stale|expected-grey|lane-did-not-run)"/u
    );
    expect(result.summary.cellsMissing).toBe(
      runGenerate(makeFixtureRoot()).summary.cellsMissing
    );
    expect(result.summary.appScenarioCells).toEqual({
      owned: 1,
      gap: 1,
      bug: 1,
      skipped: 0,
    });
  });

  test("product-bug is not the gap family", () => {
    const grid = buildAppScenarioGrid(scenariosMatrix());
    const pin = grid.apps[0].rows.find((row) => row.id === "pin-empty");
    const gate = grid.apps[0].rows.find((row) => row.id === "gate");
    expect(pin.state).toBe("bug");
    expect(gate.state).toBe("unowned");
    expect(countScenarioCells(grid)).toEqual({
      owned: 1,
      gap: 1,
      bug: 1,
      skipped: 0,
    });
  });
});
