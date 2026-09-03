#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./lint-e2e-wiring.reach.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const APPS_DIR = "packages/blueprints/apps";
export const LANE_PREAMBLE = "apps/mobile/scripts/android-emulator-install.sh";
export const SEEDER = `${MOBILE_DIR}/seed-demo-corpus.mjs`;
const LANE_HANDOFF = "export MAESTRO_PLATFORM";
const ALWAYS_EARNS_GRID = new Set(["locker"]);

const COVER_RE = /Open (?<app>[A-Z][a-zA-Z]*)/gu;

export function stateVarietyProblems(matrix) {
  const problems = [];
  for (const app of matrix?.appStates?.apps ?? []) {
    for (const [state, cell] of Object.entries(app.states ?? {})) {
      const owner = cell?.owner;
      if (typeof owner !== "string" || !owner.includes(`${MOBILE_DIR}/`))
        continue;
      problems.push(
        `appStates.${app.id}.${state} names ${owner} as its owner. State variety is ` +
          `tests/integration-mobile/'s — it arranges all seven designed states as boot ` +
          `conditions over a real gateway and a real replica session, on Linux, in about ` +
          `two minutes. A device minute costs roughly 600 Vitest seconds, so this cell is ` +
          `the same claim at 600x. Move the owner to tests/integration-mobile/ or record ` +
          `the cell as a deliberate n/a with a reason.`
      );
    }
  }
  return problems;
}

export function corpusProblems({ apps, flows, readFile }) {
  const problems = [];
  const seedable = new Set(
    apps.filter((app) => app.seedable).map((app) => app.id)
  );
  const known = new Set(apps.map((app) => app.id));

  for (const flow of flows) {
    let source;
    try {
      source = stripComments(readFile(flow));
    } catch {
      continue;
    }
    const covers = new Set(
      [...source.matchAll(COVER_RE)]
        .map((match) => match.groups.app.toLowerCase())
        .filter((id) => known.has(id))
    );
    for (const id of [...covers].sort()) {
      if (seedable.has(id) || ALWAYS_EARNS_GRID.has(id)) continue;
      problems.push(
        `${flow} taps the \`Open ${id}\` launcher tile, but ${id} ships no ` +
          `${APPS_DIR}/${id}/seed.js and is not one the springboard promotes on an ` +
          `empty vault. \`tileEarnsGrid\` only promotes a tile with content, so that ` +
          `tile does not exist in CI and the tap fails with \`Element not found\`. ` +
          `Seed the app or reach its cover through the all-apps sheet, which lists ` +
          `every app regardless of rows.`
      );
    }
  }

  const preamble = stripComments(readFile(LANE_PREAMBLE));
  const seedAt = preamble.indexOf(SEEDER);
  const handoffAt = preamble.indexOf(LANE_HANDOFF);
  if (seedAt === -1) {
    problems.push(
      `${LANE_PREAMBLE} never runs ${SEEDER}. A lane is many flows sharing ONE ` +
        `pairing, and a flow's own \`ensureDemo\` writes to the gateway only — so ` +
        `every seed after the first pairing is invisible to the phone. Home reads the ` +
        `vault as empty and renders DayOne instead of the launcher grid (#905).`
    );
  } else if (handoffAt !== -1 && seedAt > handoffAt) {
    problems.push(
      `${LANE_PREAMBLE} runs ${SEEDER} AFTER \`${LANE_HANDOFF}\`. Seeding has to ` +
        `precede the first replica clone to be seen at all; ordering it after the ` +
        `handoff restores the #905 defect while looking like the fix.`
    );
  }
  return problems;
}

export function discoverApps(root = ROOT) {
  const dir = path.resolve(root, APPS_DIR);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => ({
      id: entry.name,
      seedable: existsSync(path.join(dir, entry.name, "seed.js")),
    }));
}
