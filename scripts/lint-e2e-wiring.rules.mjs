#!/usr/bin/env node
// THE CONTENT RULES of the mobile e2e wiring linter — RULE `state-variety` and
// RULE `corpus` (#905, #915 Wave 2).
//
// Second of the two modules split out of `scripts/lint-e2e-wiring.mjs` when it
// crossed the repo's god-file ceiling; the other is
// `lint-e2e-wiring.reach.mjs`. The split is by QUESTION, not by size: reach
// asks "does anything run this flow", these two ask "is what it runs able to
// see anything". Both are re-exported from the linter, so its unit spec and any
// other caller import from one place, and its always-on `selfTest()` drives
// them through the same rule engine it always did.

import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { stripComments } from "./lint-e2e-wiring.reach.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const MOBILE_DIR = "tests/agent-e2e-mobile";
const APPS_DIR = "packages/blueprints/apps";
/** Sourced by every Android device lane script, so the seeding it carries is
 *  the one place that covers the PR gate, the canary and the nightly. */
export const LANE_PREAMBLE = "apps/mobile/scripts/android-emulator-install.sh";
export const SEEDER = `${MOBILE_DIR}/seed-demo-corpus.mjs`;
/** The handoff. Everything after this export is Maestro's, so the corpus has
 *  to be in the gateway before it. */
const LANE_HANDOFF = "export MAESTRO_PLATFORM";
/** `locker`'s tile body is a STATE, not a query result, so `tileEarnsGrid`
 *  promotes it on an empty vault and it ships no scenario. */
const ALWAYS_EARNS_GRID = new Set(["locker"]);

/** `Open Photos.*` / `Open Docs.*` — a launcher-tile tap. Filtered against the
 *  real app ids below, so `Open Mom's chili` (a note's own name) is not one. */
const COVER_RE = /Open (?<app>[A-Z][a-zA-Z]*)/gu;

/**
 * RULE state-variety: no app x designed-state cell may be owned by a device.
 *
 * `tests/integration-mobile/` boots the shipped gateway and a real native
 * replica session and arranges each of the seven canonical designed states as a
 * boot condition — eight apps x seven states, on Linux, in about two minutes.
 * A simulator minute costs roughly 600 Vitest seconds. So a designed-state cell
 * that names a Maestro journey as its owner is not extra assurance; it is the
 * same claim bought at 600x, and `roster.json`'s `$doctrine` says the roster
 * SHRINKS rather than fans out. This is that sentence with teeth.
 *
 * Reads the `appStates` layer of whichever ledger is present — the claims file
 * or the matrix — because the shape is identical in both and slice REPORT's
 * replacement must not silently drop the rule.
 */
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

/**
 * The two halves of RULE corpus. Pure over an injected app table and `readFile`
 * so the self-test can drive both a clean tree and each defect.
 *
 * `apps` is `[{ id, seedable }]` — read from `packages/blueprints/apps/` by the
 * caller, never a hand-kept list, because a hand-kept list is exactly what
 * drifts away from the blueprints that ship.
 */
export function corpusProblems({ apps, flows, readFile }) {
  const problems = [];
  const seedable = new Set(
    apps.filter((app) => app.seedable).map((app) => app.id)
  );
  const known = new Set(apps.map((app) => app.id));

  // (a) A tap on a cover whose app can never earn the grid.
  for (const flow of flows) {
    // A flow that cannot be read is RULE rostered's finding, not this one, and
    // reporting it twice under two rules reads as two defects. In the real run
    // `flows` comes from `discoverFlows()`, so every entry is on disk and this
    // never skips; it is reachable only from a fixture that names a deleted file.
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

  // (b) The lane must seed before it hands off to Maestro.
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

/** The bundled apps, and which ship a demo scenario. Directories only — the
 *  tree also carries loose `.ts` files that are not apps. */
export function discoverApps(root = ROOT) {
  const dir = path.resolve(root, APPS_DIR);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => ({
      id: entry.name,
      seedable: existsSync(path.join(dir, entry.name, "seed.js")),
    }));
}
