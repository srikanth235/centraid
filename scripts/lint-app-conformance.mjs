#!/usr/bin/env node
/**
 * THE SHELL↔APP CONFORMANCE GATE (#905 Part 2).
 *
 * WHY THIS EXISTS. Four tables in three trees have to agree before a launcher
 * tile can reach a screen:
 *
 *   packages/design/src/apps.ts               the registry — who exists at all
 *   apps/mobile/src/screens/home/catalog.ts   the launcher route per app id
 *   apps/mobile/src/screens/Home.tsx          the switch that navigates
 *   apps/mobile/src/deep-links.ts             the `centraid://` path table
 *
 * Nothing linked them. Each could move alone and stay green, and the failure is
 * the family this whole issue is about: a verdict reported without being earned.
 * A registered app whose route is missing from `catalog.ts` never reaches the
 * grid at all — and `buildLauncherItems` drops it SILENTLY (`route ? [...] : []`),
 * so the launcher renders seven tiles where eight are registered and every test
 * that derives its expectation from the catalog agrees with the defect.
 *
 * `apps/mobile/app-conformance.json` is the fifth table that pins the other
 * four, and this is what holds them against it. It is also what makes the
 * coverage claim in #905 Part 2 true rather than aspirational: **a new app is
 * covered the day it registers, or the PR that registers it fails here.** No
 * per-app authoring, no roster to remember to extend.
 *
 * SIX RULES.
 *
 *   registry-complete   The manifest's app ids and the registry's are exact
 *     complements, BOTH WAYS. A registered app with no row is the uncovered
 *     app #9; a row for an app nobody registers is a claim about nothing, which
 *     reads like coverage and is not.
 *   route-registered    Each row's `route` is what `catalog.ts` maps that id to.
 *     This is the rule that catches the silent `flatMap` drop above.
 *   navigates           Home's switch answers each row's `route` by navigating
 *     to its declared `navigator` (and `screen`, where the row declares one).
 *     A tile that opens the wrong cover is a product bug no unit sees, because
 *     each half is individually correct.
 *   deep-link-routed    `deep-links.ts` maps that same navigator/screen pair to
 *     the row's `centraid://` path. Tile and link must land on ONE screen; the
 *     two tables are written 300 lines apart and share no type.
 *   handles-declared    The row's `tile` and `landmark` ids resolve in
 *     `apps/mobile/src/kit/test-ids.ts` — the tile under the `homeTile` family
 *     prefix, the landmark exactly. An app with no arrival handle cannot be
 *     asserted on by the device layer, so the manifest may not claim it can.
 *   seed-declared       `seeded` is true exactly when
 *     `packages/blueprints/apps/<id>/seed.js` exists. The device lane seeds
 *     every scenario that ships one before it pairs (`seed-demo-corpus.mjs`), so
 *     a row that lies about its fixture is a journey that will fail on an app
 *     behaving correctly — which is precisely how #905's corpus defect read.
 *
 * WHAT THIS CANNOT SEE, said plainly: it matches text, not a render tree. It
 * proves the tables agree, not that the screen mounts. That second claim belongs
 * to the generated sweep in `apps/mobile/src/screens/Home.test.tsx` (the
 * shell↔app contract mounted against the real registry) and, for the parts only
 * a device can answer, to the Maestro layer. This is the cheap tripwire in front
 * of both — the same relation `lint-mobile-testids.mjs` has to the flows it
 * guards.
 *
 * Following lint-path-filters.mjs and lint-mobile-testids.mjs: A SILENT NO-OP IS
 * A FAILURE. Zero manifest rows, zero registry ids, an unreadable source table,
 * or an empty testID vocabulary each FAIL rather than pass — every one is the
 * shape this linter takes once a table it parses has been reformatted out from
 * under it, and "we found nothing to check" must never read as "nothing is
 * wrong". A self-test of every rule runs first on inline fixtures, so the linter
 * cannot rot into always-passing.
 *
 * Offline, no TypeScript dependency (line/brace scanning, the convention of
 * `lint-workflow-pins.mjs`), ~20 ms.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

const MANIFEST_PATH = "apps/mobile/app-conformance.json";
const REGISTRY_PATH = "packages/design/src/apps.ts";
const CATALOG_PATH = "apps/mobile/src/screens/home/catalog.ts";
const HOME_PATH = "apps/mobile/src/screens/Home.tsx";
const DEEP_LINKS_PATH = "apps/mobile/src/deep-links.ts";
const TEST_IDS_PATH = "apps/mobile/src/kit/test-ids.ts";
const BLUEPRINTS_DIR = "packages/blueprints/apps";

/** The launcher tile handle family, mirrored from `TEST_ID_PREFIXES.homeTile`. */
const HOME_TILE_PREFIX = "home-tile-";

// ---------------------------------------------------------------- parsing ---
//
// Every parser below returns `undefined` when it cannot find its table, and
// every caller turns that into a FAILURE rather than an empty result. That
// asymmetry is the whole no-op guard: a reformatted source must red the gate,
// not quietly satisfy it.

/** Registered app ids, in registry order. `id: "notes"` inside `BUILTIN_APPS`. */
export function parseRegistryIds(source) {
  const ids = [...source.matchAll(/^\s*id: "(?<id>[a-z0-9-]+)",$/gmu)].map(
    (match) => match.groups.id
  );
  return ids.length > 0 ? ids : undefined;
}

/** `{ [appId]: routeKind }` from `catalog.ts`'s `NATIVE_ROUTES` table. */
export function parseCatalogRoutes(source) {
  const table = braceBlock(source, "const NATIVE_ROUTES");
  if (table === undefined) return undefined;
  const routes = {};
  for (const match of table.matchAll(
    /^\s*(?<app>[a-z0-9-]+): \{ kind: "(?<kind>[a-z0-9-]+)" \},$/gmu
  ))
    routes[match.groups.app] = match.groups.kind;
  return Object.keys(routes).length > 0 ? routes : undefined;
}

/**
 * `{ [routeKind]: { navigator, screen } }` from Home's `openItem` switch.
 *
 * Each arm is `case "<kind>":` followed by one `navigation.navigate(...)`, so
 * the parse is: split on `case "`, read the navigate call in the arm's own text.
 */
export function parseHomeNavigation(source) {
  const arms = source.split(/\bcase "/u).slice(1);
  if (arms.length === 0) return undefined;
  const table = {};
  for (const arm of arms) {
    const kind = /^(?<kind>[a-z0-9-]+)":/u.exec(arm)?.groups?.kind;
    if (kind === undefined) continue;
    const body = arm.split(/\n\s*break;/u)[0];
    const call =
      /navigation\.navigate\(\s*"(?<nav>[A-Za-z]+)"(?:,\s*\{ screen: "(?<screen>[A-Za-z]+)" \})?/u.exec(
        body
      );
    if (!call) continue;
    table[kind] = {
      navigator: call.groups.nav,
      screen: call.groups.screen ?? null,
    };
  }
  return Object.keys(table).length > 0 ? table : undefined;
}

/**
 * `{ [navigator]: { path?, screens? } }` from `LINKING.config.screens`.
 *
 * A navigator is either `Notes: "apps/notes"` (one screen, one path) or a
 * `{ screens: { … } }` block. Both shapes are read, because the app ships both.
 */
export function parseDeepLinks(source) {
  const screens = braceBlock(source, "screens:");
  if (screens === undefined) return undefined;
  const table = {};
  for (const match of screens.matchAll(
    /^ {6}(?<nav>[A-Za-z]+): "(?<path>[^"]*)",$/gmu
  ))
    table[match.groups.nav] = { path: match.groups.path };
  for (const match of screens.matchAll(/^ {6}(?<nav>[A-Za-z]+): \{$/gmu)) {
    const nested = braceBlock(screens, `${match.groups.nav}: {`);
    if (nested === undefined) continue;
    const paths = {};
    for (const inner of nested.matchAll(
      /^\s*(?<screen>[A-Za-z]+): "(?<path>[^"]*)",$/gmu
    ))
      paths[inner.groups.screen] = inner.groups.path;
    table[match.groups.nav] = { screens: paths };
  }
  return Object.keys(table).length > 0 ? table : undefined;
}

/** Every kebab-case string literal declared in `test-ids.ts` — the vocabulary. */
export function parseTestIds(source) {
  const ids = new Set(
    [...source.matchAll(/"(?<id>[a-z][a-z0-9-]*)"/gu)].map(
      (match) => match.groups.id
    )
  );
  return ids.size > 0 ? ids : undefined;
}

/**
 * The `{ … }` following the first line containing `opener`, brace-matched.
 * Returned WITHOUT the outer braces. `undefined` when the opener is absent —
 * the signal that the table this linter reads has moved.
 */
function braceBlock(source, opener) {
  const at = source.indexOf(opener);
  if (at < 0) return undefined;
  const open = source.indexOf("{", at);
  if (open < 0) return undefined;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ rules ---

/**
 * Every problem, as a flat list of sentences. Pure: the caller reads the trees
 * and hands the parsed tables in, which is what lets the self-test drive every
 * rule off fixtures rather than off this repo's current (passing) state.
 */
export function lintConformance({
  manifest,
  registryIds,
  catalogRoutes,
  homeNavigation,
  deepLinks,
  testIds,
  hasSeed,
}) {
  const errors = [];
  const rows = Object.entries(manifest?.apps ?? {});
  if (rows.length === 0)
    return [
      `${MANIFEST_PATH} declares no apps. An empty manifest passes every rule below while proving nothing — refusing.`,
    ];

  const declared = new Set(rows.map(([id]) => id));
  for (const id of registryIds)
    if (!declared.has(id))
      errors.push(
        `registry-complete: \`${id}\` is registered in ${REGISTRY_PATH} and has no row in ${MANIFEST_PATH}. Add one — the conformance sweep enumerates the manifest, so an app with no row ships uncovered.`
      );
  for (const id of declared)
    if (!registryIds.includes(id))
      errors.push(
        `registry-complete: \`${id}\` has a manifest row and is not registered in ${REGISTRY_PATH}. A row for an app nobody ships reads like coverage and is not; delete it or register the app.`
      );

  for (const [id, row] of rows) {
    const at = `${MANIFEST_PATH} → ${id}`;

    if (catalogRoutes[id] !== row.route)
      errors.push(
        `route-registered: ${at} declares route \`${row.route}\`; ${CATALOG_PATH} maps \`${id}\` to ${catalogRoutes[id] === undefined ? "NOTHING" : `\`${catalogRoutes[id]}\``}. \`buildLauncherItems\` drops an unmapped id silently, so the launcher would render one tile fewer and every catalog-derived expectation would agree with the defect.`
      );

    const nav = homeNavigation[row.route];
    if (nav === undefined)
      errors.push(
        `navigates: ${at} declares route \`${row.route}\`; Home's \`openItem\` switch in ${HOME_PATH} has no arm for it, so tapping the tile does nothing.`
      );
    else if (nav.navigator !== row.navigator || nav.screen !== row.screen)
      errors.push(
        `navigates: ${at} declares \`${row.navigator}${row.screen ? `/${row.screen}` : ""}\`; ${HOME_PATH} navigates to \`${nav.navigator}${nav.screen ? `/${nav.screen}` : ""}\`. The tile opens a different cover than the manifest — and than the deep link — claims.`
      );

    const entry = deepLinks[row.navigator];
    const linked = entry?.screens
      ? entry.screens[row.screen ?? ""]
      : entry?.path;
    if (linked !== row.deepLink)
      errors.push(
        `deep-link-routed: ${at} declares \`centraid://${row.deepLink}\`; ${DEEP_LINKS_PATH} routes \`${row.navigator}${row.screen ? `/${row.screen}` : ""}\` to ${linked === undefined ? "NOTHING" : `\`centraid://${linked}\``}. A tile and its link must land on one screen.`
      );

    if (row.tile !== `${HOME_TILE_PREFIX}${id}`)
      errors.push(
        `handles-declared: ${at} declares tile \`${row.tile}\`; the \`homeTile\` family in ${TEST_IDS_PATH} builds \`${HOME_TILE_PREFIX}${id}\` from the app id. The handle is not free-form — it is what LauncherGrid renders.`
      );
    if (!testIds.has(row.landmark))
      errors.push(
        `handles-declared: ${at} declares landmark \`${row.landmark}\`, which ${TEST_IDS_PATH} does not declare. A landmark nothing renders is a selector that matches nothing, and \`assertNotVisible\` on it passes forever.`
      );

    if (hasSeed(id) !== row.seeded)
      errors.push(
        `seed-declared: ${at} says \`seeded: ${row.seeded}\`; ${BLUEPRINTS_DIR}/${id}/seed.js ${hasSeed(id) ? "exists" : "does not exist"}. The lane seeds every scenario that ships one before it pairs, so a row that lies about its fixture sends a journey at an app that is behaving correctly.`
      );
  }

  return errors;
}

// -------------------------------------------------------------- self-test ---

/**
 * Drive every rule off fixtures before touching the tree. Without this the
 * linter's own passing is unfalsifiable: a parser that silently returns an
 * empty table makes the rules vacuous, and the repo would report green.
 */
function selfTest() {
  const good = {
    manifest: {
      apps: {
        notes: {
          route: "notes",
          navigator: "Notes",
          screen: null,
          deepLink: "apps/notes",
          tile: "home-tile-notes",
          landmark: "notes-band",
          seeded: true,
        },
      },
    },
    registryIds: ["notes"],
    catalogRoutes: { notes: "notes" },
    homeNavigation: { notes: { navigator: "Notes", screen: null } },
    deepLinks: { Notes: { path: "apps/notes" } },
    testIds: new Set(["notes-band"]),
    hasSeed: () => true,
  };
  const cases = [
    ["a clean manifest", good, 0],
    ["an empty manifest", { ...good, manifest: { apps: {} } }, 1],
    [
      "an unrowed registered app",
      { ...good, registryIds: ["notes", "tally"] },
      1,
    ],
    ["a row for an unregistered app", { ...good, registryIds: [] }, 1],
    ["a route the catalog does not map", { ...good, catalogRoutes: {} }, 1],
    ["a route Home does not answer", { ...good, homeNavigation: {} }, 1],
    [
      "a tile that opens the wrong cover",
      {
        ...good,
        homeNavigation: { notes: { navigator: "Tally", screen: null } },
      },
      1,
    ],
    ["a deep link routed elsewhere", { ...good, deepLinks: {} }, 1],
    ["a landmark nothing declares", { ...good, testIds: new Set() }, 1],
    ["a fixture that does not exist", { ...good, hasSeed: () => false }, 1],
  ];
  for (const [name, input, expected] of cases) {
    const found = lintConformance(input).length;
    if (found !== expected)
      throw new Error(
        `app-conformance self-test: ${name} produced ${found} error(s), expected ${expected}. The rules have rotted; fix them before trusting this gate.`
      );
  }
}

// ------------------------------------------------------------------- main ---

function read(relative) {
  return readFileSync(path.resolve(ROOT, relative), "utf8");
}

function main() {
  selfTest();

  const manifest = JSON.parse(read(MANIFEST_PATH));
  const parsed = {
    registryIds: parseRegistryIds(read(REGISTRY_PATH)),
    catalogRoutes: parseCatalogRoutes(read(CATALOG_PATH)),
    homeNavigation: parseHomeNavigation(read(HOME_PATH)),
    deepLinks: parseDeepLinks(read(DEEP_LINKS_PATH)),
    testIds: parseTestIds(read(TEST_IDS_PATH)),
  };
  const sources = {
    registryIds: REGISTRY_PATH,
    catalogRoutes: CATALOG_PATH,
    homeNavigation: HOME_PATH,
    deepLinks: DEEP_LINKS_PATH,
    testIds: TEST_IDS_PATH,
  };
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) continue;
    console.error(
      `app-conformance: could not read the table this gate compares against in ${sources[key]} — refusing to pass without checking anything. The file was reformatted out from under the parser in this script.`
    );
    process.exitCode = 1;
    return;
  }

  const errors = lintConformance({
    ...parsed,
    manifest,
    hasSeed: (id) =>
      existsSync(path.resolve(ROOT, BLUEPRINTS_DIR, id, "seed.js")),
  });
  if (errors.length) {
    for (const error of errors) console.error(`app-conformance: ${error}`);
    console.error(`app-conformance: ${errors.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `app-conformance: ${Object.keys(manifest.apps).length} first-party app(s) — registry, launcher catalog, Home's navigate switch, the deep-link table and the testID vocabulary all agree with ${MANIFEST_PATH}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
