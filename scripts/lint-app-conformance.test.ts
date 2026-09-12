/* oxlint-disable vitest/no-import-node-test -- (#1018) node --test lane, not a vitest suite */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- (#1018) node --test lane, not a vitest suite */
// The half `selfTest()` cannot cover (#905 Part 2).
//
// `lint-app-conformance.mjs` runs its rules against inline fixtures before it
// touches the tree, which proves the RULES work. It cannot prove the PARSERS do
// — a parser that quietly returns an empty table makes every rule vacuous, and
// the linter would report green on a tree it never read. So these tests run the
// parsers against the REAL committed sources and assert they came back with the
// tables this repo actually ships, by name.
//
// That is deliberately a coupling to current content. It is the coupling that
// matters: the day `deep-links.ts` is reformatted so its nesting no longer
// matches, this file fails with "the parser found nothing" rather than the gate
// silently passing everything.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  lintConformance,
  parseCatalogRoutes,
  parseDeepLinks,
  parseHomeNavigation,
  parseRegistryIds,
  parseTestIds,
} from "./lint-app-conformance.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative: string) =>
  readFileSync(path.resolve(ROOT, relative), "utf8");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ConformanceRow = {
  route: string;
  navigator: string;
  screen: string | null;
  landmark: string;
};

const manifest: unknown = JSON.parse(read("apps/mobile/app-conformance.json"));
const manifestAppsRaw =
  isRecord(manifest) && isRecord(manifest.apps) ? manifest.apps : {};
const manifestApps: Record<string, ConformanceRow> = (() => {
  const out: Record<string, ConformanceRow> = {};
  for (const [id, raw] of Object.entries(manifestAppsRaw)) {
    if (!isRecord(raw) || typeof raw.route !== "string") continue;
    out[id] = {
      route: raw.route,
      navigator: typeof raw.navigator === "string" ? raw.navigator : "",
      screen: typeof raw.screen === "string" ? raw.screen : null,
      landmark: typeof raw.landmark === "string" ? raw.landmark : "",
    };
  }
  return out;
})();
const APP_IDS = Object.keys(manifestApps).sort();

test("the registry parser finds every first-party app", () => {
  const ids = parseRegistryIds(read("packages/design/src/apps.ts"));
  assert.ok(ids);
  assert.deepEqual([...ids].sort(), APP_IDS);
});

test("the catalog parser finds a route for every app", () => {
  const routes = parseCatalogRoutes(
    read("apps/mobile/src/screens/home/catalog.ts")
  );
  assert.ok(routes);
  assert.deepEqual(Object.keys(routes).sort(), APP_IDS);
});

test("Home's switch parses to a navigator for every launcher route", () => {
  const table = parseHomeNavigation(read("apps/mobile/src/screens/Home.tsx"));
  assert.ok(table);
  for (const [id, row] of Object.entries(manifestApps))
    assert.deepEqual(
      table[row.route],
      { navigator: row.navigator, screen: row.screen },
      `Home's arm for ${id}`
    );
});

test("the deep-link parser reads both table shapes", () => {
  const table = parseDeepLinks(read("apps/mobile/src/deep-links.ts"));
  assert.ok(table);
  // `Notes: "apps/notes"` — a navigator that is one screen and one path.
  assert.equal(table.Notes?.path, "apps/notes");
  // `Photos: { screens: { PhotosHome: "photos", … } }` — the nested shape.
  assert.equal(table.Photos?.screens?.PhotosHome, "photos");
});

test("the testID vocabulary carries every declared landmark", () => {
  const ids = parseTestIds(read("apps/mobile/src/kit/test-ids.ts"));
  assert.ok(ids);
  for (const row of Object.values(manifestApps))
    assert.ok(ids.has(row.landmark), `${row.landmark} is declared`);
});

test("a parser that finds nothing reports undefined, never an empty table", () => {
  // The no-op guard, from the parser side: `main()` turns each of these into a
  // refusal to pass. An empty object here would instead make every rule vacuous.
  assert.equal(parseRegistryIds("// nothing"), undefined);
  assert.equal(parseCatalogRoutes("// nothing"), undefined);
  assert.equal(parseHomeNavigation("// nothing"), undefined);
  assert.equal(parseDeepLinks("// nothing"), undefined);
  assert.equal(parseTestIds("// NOTHING"), undefined);
});

test("the committed tree passes every rule", () => {
  const registryIds = parseRegistryIds(read("packages/design/src/apps.ts"));
  const catalogRoutes = parseCatalogRoutes(
    read("apps/mobile/src/screens/home/catalog.ts")
  );
  const homeNavigation = parseHomeNavigation(
    read("apps/mobile/src/screens/Home.tsx")
  );
  const deepLinks = parseDeepLinks(read("apps/mobile/src/deep-links.ts"));
  const testIds = parseTestIds(read("apps/mobile/src/kit/test-ids.ts"));
  assert.ok(
    registryIds && catalogRoutes && homeNavigation && deepLinks && testIds
  );
  const errors = lintConformance({
    manifest: { apps: manifestAppsRaw },
    registryIds,
    catalogRoutes,
    homeNavigation,
    deepLinks,
    testIds,
    hasSeed: (id: string) => id !== "locker",
  });
  assert.deepEqual(errors, []);
});
