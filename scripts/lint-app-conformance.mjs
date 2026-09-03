#!/usr/bin/env node

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

const HOME_TILE_PREFIX = "home-tile-";

export function parseRegistryIds(source) {
  const ids = [...source.matchAll(/^\s*id: "(?<id>[a-z0-9-]+)",$/gmu)].map(
    (match) => match.groups.id
  );
  return ids.length > 0 ? ids : undefined;
}

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

export function parseTestIds(source) {
  const ids = new Set(
    [...source.matchAll(/"(?<id>[a-z][a-z0-9-]*)"/gu)].map(
      (match) => match.groups.id
    )
  );
  return ids.size > 0 ? ids : undefined;
}

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
