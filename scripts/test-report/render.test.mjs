import path from "node:path";

import { describe, expect, test } from "vitest";

import { buildSummary } from "./generate.mjs";
import {
  checkEvidenceMapping,
  resolveLanes,
  stepsIn,
} from "./lint-evidence-mapping.mjs";
import { renderRollingIssueBody } from "./rolling-issue-body.mjs";
import { REQUIRED_SECTIONS, renderFixture, smokeFailures } from "./smoke.mjs";

/**
 * The page, end to end, from the committed fixture root.
 *
 * `report:smoke` runs the same checks on rung 1; these assert the parts a
 * reader would notice going wrong and that `smoke.mjs` only summarises — the
 * four-word vocabulary, the keys, and the agreement between §3 and the rolling
 * issue body.
 */

describe("the rendered page", () => {
  test("renders every section from the fixture root with no validation errors", async () => {
    expect(await smokeFailures()).toEqual([]);
  });

  test("names every section the reader is promised", async () => {
    const { html } = await renderFixture();
    for (const [marker] of REQUIRED_SECTIONS) expect(html).toContain(marker);
  });

  test("draws the four-word vocabulary and nothing else", async () => {
    const { html } = await renderFixture();
    const words = [
      ...html.matchAll(/<span class="pill (?<state>[a-z-]+)"/gu),
    ].map((hit) => hit.groups.state);
    expect(new Set(words).size).toBeGreaterThan(1);
    for (const word of new Set(words)) {
      expect([
        "passed",
        "failed",
        "parked",
        "degraded",
        "no-evidence",
        "na",
        "gating",
        "advisory",
      ]).toContain(word);
    }
    expect(html).not.toMatch(/>flaky</u);
    expect(html).not.toMatch(/No trend yet/u);
  });

  test("carries the lane filters, the name search and the three keys", async () => {
    const { html } = await renderFixture();
    expect(html).toContain('id="laneFilters"');
    expect(html).toContain('id="laneSearch"');
    expect(html).toMatch(/<kbd>\/<\/kbd>/u);
    expect(html).toMatch(/<kbd>e<\/kbd>/u);
    expect(html).toMatch(/<kbd>\?<\/kbd>/u);
  });

  test("every lane row is in the markup, so the page reads without script", async () => {
    const { model, html } = await renderFixture();
    for (const row of model.lanes)
      expect(html).toContain(`data-name="${row.lane}"`);
  });

  test("says where every tab of the old report went", async () => {
    const { html } = await renderFixture();
    for (const tab of [
      "Attention",
      "Product",
      "States",
      "Scenarios",
      "Consent",
      "Joins",
      "Journeys",
      "Adversaries",
      "Infrastructure",
      "Detail shelf",
    ]) {
      expect(html).toContain(`<td>${tab}</td>`);
    }
  });

  test("the verdict lamp, the why and the flip are all on the first screen", async () => {
    const { model, html } = await renderFixture();
    const firstScreen = html.slice(0, html.indexOf('id="ship"'));
    expect(firstScreen).toContain(model.verdict.verdict);
    expect(firstScreen).toContain("to flip:");
    expect(firstScreen).toContain("Can we ship the candidate?");
  });
});

describe("the rolling issue body", () => {
  test("agrees with §3 about the deadline for the same lane", async () => {
    const { model } = await renderFixture();
    const summary = buildSummary(model);
    const queued = model.attention.find(
      (entry) => entry.lane === "mobile-e2e-android"
    );
    expect(queued).toBeDefined();
    const body = renderRollingIssueBody({
      lane: "mobile-e2e-android",
      summary,
      evidence: { verdict: "parked", cases: [] },
    });
    // §3 says "expires 2026-09-16"; the issue must say the same date.
    expect(queued.deadline).toContain(queued.issue ? "expires" : "");
    expect(body).toContain(queued.deadline.replace("expires ", ""));
    expect(body).toContain("parked until");
  });

  test("carries the bisection bounds for a blocker", async () => {
    const { model } = await renderFixture();
    const summary = buildSummary(model);
    const body = renderRollingIssueBody({
      lane: "mobile-e2e-ios",
      summary,
      evidence: {
        verdict: "failed",
        cases: [
          {
            id: "locker-gate",
            verdict: "failed",
            durationMs: 184_000,
            attempts: 3,
          },
        ],
      },
    });
    expect(body).toContain("locker-gate");
    expect(body).toContain("Bisection bounds");
    expect(body).toContain("rewritten in place");
  });
});

describe("lint:evidence-mapping", () => {
  const lanes = [
    {
      id: "static",
      rung: 2,
      platform: "any",
      budgetMs: 1,
      qualities: [],
      surfaces: [],
      status: "gating",
    },
  ];

  test("a step naming an unregistered lane is an error, never a banner", () => {
    const workflows = {
      "ci.yml":
        "      - name: Write lane evidence\n        run: node scripts/test-report/write-evidence.mjs --lane ghost --rung 2 --platform any\n",
    };
    const { errors } = checkEvidenceMapping({ workflows, lanes });
    expect(errors.join(" ")).toContain(
      'lane "ghost", which tests/claims.json#lanes does not register'
    );
  });

  test("a rung that disagrees with the registry is an error", () => {
    const workflows = {
      "ci.yml":
        "      - name: Write lane evidence\n        run: node scripts/test-report/write-evidence.mjs --lane static --rung 4 --platform any\n",
    };
    const { errors } = checkEvidenceMapping({ workflows, lanes });
    expect(errors.join(" ")).toContain(
      "writes --rung 4; the registry puts it on rung 2"
    );
  });

  test("a registered lane nobody writes yet is a warning, not a failure", () => {
    const { errors, warnings } = checkEvidenceMapping({ workflows: {}, lanes });
    expect(errors).toEqual([]);
    expect(warnings.join(" ")).toContain("renders as no evidence");
  });

  test("resolves a matrix leg and a loop over reusable-workflow results", () => {
    expect(resolveLanes(`coverage-shard-\${{ matrix.shard }}`, "")).toEqual([
      "coverage-shard",
    ]);
    expect(
      resolveLanes(
        "$lane",
        `for pair in "web-e2e-linux:\${{ needs.a.result }}" "desktop-e2e-linux:\${{ needs.b.result }}"`
      )
    ).toEqual(["web-e2e-linux", "desktop-e2e-linux"]);
  });

  test("reads the flags off a wrapped step", () => {
    const steps = stepsIn(
      "        run: >\n          node scripts/test-report/write-evidence.mjs\n          --lane static --rung 2 --platform any --budget-ms 900000\n"
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      lane: "static",
      rung: "2",
      platform: "any",
    });
  });
});

describe("the real workflows", () => {
  test("every evidence step in the repo names a registered lane", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { loadClaims } = await import("./claims-schema.mjs");
    const dir = path.resolve(import.meta.dirname, "../../.github/workflows");
    const workflows = {};
    for (const name of readdirSync(dir)) {
      if (name.endsWith(".yml"))
        workflows[name] = readFileSync(path.join(dir, name), "utf8");
    }
    const { claims } = loadClaims();
    expect(
      checkEvidenceMapping({ workflows, lanes: claims.lanes }).errors
    ).toEqual([]);
  });
});
