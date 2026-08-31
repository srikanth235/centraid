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
} from "./lint-app-conformance.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (relative) => readFileSync(path.resolve(ROOT, relative), "utf8");

const manifest = JSON.parse(read("apps/mobile/app-conformance.json"));
const APP_IDS = Object.keys(manifest.apps).sort();

test("the registry parser finds every first-party app", () => {
  const ids = parseRegistryIds(read("packages/design/src/apps.ts"));
  assert.deepEqual([...ids].sort(), APP_IDS);
});

test("the catalog parser finds a route for every app", () => {
  const routes = parseCatalogRoutes(
    read("apps/mobile/src/screens/home/catalog.ts")
  );
  assert.deepEqual(Object.keys(routes).sort(), APP_IDS);
});

test("Home's switch parses to a navigator for every launcher route", () => {
  const table = parseHomeNavigation(read("apps/mobile/src/screens/Home.tsx"));
  for (const [id, row] of Object.entries(manifest.apps))
    assert.deepEqual(
      table[row.route],
      { navigator: row.navigator, screen: row.screen },
      `Home's arm for ${id}`
    );
});

test("the deep-link parser reads both table shapes", () => {
  const table = parseDeepLinks(read("apps/mobile/src/deep-links.ts"));
  // `Notes: "apps/notes"` — a navigator that is one screen and one path.
  assert.equal(table.Notes.path, "apps/notes");
  // `Photos: { screens: { PhotosHome: "photos", … } }` — the nested shape.
  assert.equal(table.Photos.screens.PhotosHome, "photos");
});

test("the testID vocabulary carries every declared landmark", () => {
  const ids = parseTestIds(read("apps/mobile/src/kit/test-ids.ts"));
  for (const row of Object.values(manifest.apps))
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
  const errors = lintConformance({
    manifest,
    registryIds: parseRegistryIds(read("packages/design/src/apps.ts")),
    catalogRoutes: parseCatalogRoutes(
      read("apps/mobile/src/screens/home/catalog.ts")
    ),
    homeNavigation: parseHomeNavigation(
      read("apps/mobile/src/screens/Home.tsx")
    ),
    deepLinks: parseDeepLinks(read("apps/mobile/src/deep-links.ts")),
    testIds: parseTestIds(read("apps/mobile/src/kit/test-ids.ts")),
    hasSeed: (id) => id !== "locker",
  });
  assert.deepEqual(errors, []);
});
