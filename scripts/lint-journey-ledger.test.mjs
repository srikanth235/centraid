import assert from "node:assert/strict";
// oxlint-disable-next-line no-restricted-imports -- (#927) node --test lane: the kit's tempDirSync() registers a vitest hook at call time and throws here; these fixtures live under the OS temp dir for the process's life.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { lintJourneyLedger } from "./lint-journey-ledger.mjs";

/** A minimal tree the linter can walk: a ledger plus the roots it sweeps. */
function fixture(ledger, files = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "journey-ledger-"));
  for (const dir of ["apps", "packages", "scripts", "tests", ".github"])
    mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(
    path.join(root, "tests/journeys.json"),
    JSON.stringify(ledger, null, 2)
  );
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const BASE = {
  hardware: { any: "hardware-independent" },
  volumes: { year3: "the golden artifact" },
  journeys: Object.fromEntries(
    [
      "cold-open",
      "warm-switch",
      "own-echo",
      "peer-echo",
      "converge",
      "share",
      "search",
      "scroll",
      "first-bootstrap",
    ].map((name) => [name, `the ${name} journey`])
  ),
  entries: {},
  rigs: {},
};

/** Fills the 9x4 grid so a case fails only for the reason it is testing. */
function grid(extra = {}) {
  const filled = {};
  for (const surface of ["web", "desktop", "mobile", "gateway"])
    for (const journey of [
      "cold-open",
      "warm-switch",
      "own-echo",
      "peer-echo",
      "converge",
      "share",
      "search",
      "scroll",
      "first-bootstrap",
    ])
      filled[`${surface}/${journey}/year3/any`] = {
        surface,
        journey,
        volume: "year3",
        hardware: "any",
        spans: ["x"],
        consumers: [],
        tolerancePercent: 20,
        metrics: {},
      };
  return { ...filled, ...extra };
}

const entry = (over = {}) => ({
  surface: "web",
  journey: "cold-open",
  volume: "year3",
  hardware: "any",
  spans: ["web.boot"],
  consumers: ["tests/probe.ts"],
  tolerancePercent: 20,
  metrics: { coldOpen: { status: "measured", ceilingMs: 900 } },
  ...over,
});

test("a hole in the nine-journey grid fails", () => {
  const root = fixture(
    { ...BASE, entries: { "web/cold-open/year3/any": entry() } },
    { "tests/probe.ts": "" }
  );
  assert.match(lintJourneyLedger(root).join("\n"), /no entry for web\/share/u);
});

test("a well-formed ledger passes", () => {
  const root = fixture(
    { ...BASE, entries: grid({ "web/cold-open/year3/any": entry() }) },
    { "tests/probe.ts": "// the consumer" }
  );
  assert.deepEqual(lintJourneyLedger(root), []);
});

test("a key that disagrees with its own fields fails", () => {
  const root = fixture(
    {
      ...BASE,
      entries: { "web/cold-open/year3/any": entry({ surface: "desktop" }) },
    },
    { "tests/probe.ts": "" }
  );
  assert.match(
    lintJourneyLedger(root).join("\n"),
    /disagrees with its own fields/u
  );
});

test("an undeclared volume fails, so nobody writes a ceiling at an unnamed volume", () => {
  const root = fixture(
    {
      ...BASE,
      entries: grid({
        "web/cold-open/huge/any": entry({ volume: "huge" }),
      }),
    },
    { "tests/probe.ts": "" }
  );
  assert.match(lintJourneyLedger(root).join("\n"), /undeclared volume huge/u);
});

test("an entry with no span and no consumer fails", () => {
  const root = fixture({
    ...BASE,
    entries: grid({
      "web/cold-open/year3/any": entry({ spans: [], consumers: [] }),
    }),
  });
  assert.match(
    lintJourneyLedger(root).join("\n"),
    /names no span and no consumer/u
  );
});

test("a consumer that does not exist fails", () => {
  const root = fixture({
    ...BASE,
    entries: grid({ "web/cold-open/year3/any": entry() }),
  });
  assert.match(lintJourneyLedger(root).join("\n"), /which does not exist/u);
});

test("an unmeasured metric that ships a number fails", () => {
  const root = fixture(
    {
      ...BASE,
      entries: grid({
        "web/cold-open/year3/any": entry({
          metrics: { coldOpen: { status: "unmeasured", ceilingMs: 900 } },
        }),
      }),
    },
    { "tests/probe.ts": "" }
  );
  assert.match(lintJourneyLedger(root).join("\n"), /unmeasured but ships/u);
});

test("a catastrophe bound must argue itself", () => {
  const root = fixture(
    {
      ...BASE,
      entries: grid({
        "web/cold-open/year3/any": entry({
          metrics: { coldOpen: { status: "bound", maxPercent: 50 } },
        }),
      }),
    },
    { "tests/probe.ts": "" }
  );
  assert.match(
    lintJourneyLedger(root).join("\n"),
    /catastrophe bound with no _provenance.note/u
  );
});

test("a rig cross-link to a missing entry fails", () => {
  const root = fixture(
    {
      ...BASE,
      entries: { "web/cold-open/year3/any": entry() },
      rigs: {
        "tests/perf/x.perf.test.ts": { entries: ["web/gone/year3/any"] },
      },
    },
    { "tests/probe.ts": "" }
  );
  assert.match(lintJourneyLedger(root).join("\n"), /names missing entry/u);
});

test("a surviving reference to a replaced file fails", () => {
  const root = fixture(
    { ...BASE, entries: grid({ "web/cold-open/year3/any": entry() }) },
    {
      "tests/probe.ts": "",
      "tests/old.ts": 'import x from "tests/experience-budgets/web.json";',
    }
  );
  assert.match(
    lintJourneyLedger(root).join("\n"),
    /still names tests\/experience-budgets\//u
  );
});
