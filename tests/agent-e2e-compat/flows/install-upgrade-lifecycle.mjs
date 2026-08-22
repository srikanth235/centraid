// W5.4 (#842) — install / upgrade lifecycle lane runner.
//
// Install a PREVIOUS release, write real data through it, upgrade in place over
// that data, then run a journey against the upgraded install — proving an
// upgrade never eats the vault. See the .md next to this file for intent, and
// lib/upgrade.mjs for the pure assertion + judge this driver delegates to.
//
// CURRENT STATE: blocked-external (#790). The launchd install/uninstall rig is
// a NAMED #790 blocker — "No named mutable macOS user-session rig; local opt-in
// only" (TESTING.md §Named live/hardware lanes). With no installer the lane
// SKIPS WITH CITATION. The upgrade-over-data ASSERTION logic is already landed
// and unit-pinned (lib/upgrade.mjs + upgrade.test.mjs), so the moment #790
// provisions a rig, point CENTRAID_UPGRADE_PREV_INSTALLER at the previous
// release and the live path below runs — reusing the exact same judge.

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertUpgradePreservedData,
  judgeUpgradeJourney,
  resolvePreviousInstaller,
} from "../lib/upgrade.mjs";

const installer = resolvePreviousInstaller(process.env);

if (!installer.available) {
  const { verdict, reason } = judgeUpgradeJourney(installer);
  report(verdict, reason);
  process.exit(0);
}

// --- Live path (runs once #790 lands an install/uninstall rig) --------------
// The rig must ship an install harness at CENTRAID_UPGRADE_RIG (default: the
// fixture path) exporting:
//   installPrevious(installer)        → { home }  installs the prev release
//   writeSeedData(home)               → snapshot  writes rows, returns a digest map
//   upgradeInPlace(home)              → void      installs THIS build over `home`
//   snapshotData(home)                → snapshot  re-reads the same rows
//   runPostUpgradeJourney(home)       → boolean   a journey against the upgrade
//   uninstall(home)                   → void      always run in teardown
const rigPath =
  process.env.CENTRAID_UPGRADE_RIG ||
  path.join(import.meta.dirname, "../fixtures/install-rig/rig.mjs");
if (!existsSync(rigPath)) {
  report("fail", `install rig not found at ${rigPath} — cannot drive upgrade`);
  process.exit(1);
}

const rig = await import(pathToFileURL(rigPath).href);
const result = { available: true, installedPrev: false, upgraded: false };
let home;
try {
  const installed = await rig.installPrevious(installer.installer);
  home = installed.home;
  result.installedPrev = true;

  const before = await rig.writeSeedData(home);
  await rig.upgradeInPlace(home);
  result.upgraded = true;

  const after = await rig.snapshotData(home);
  result.preservation = assertUpgradePreservedData(before, after);
  result.journalPassed = await rig.runPostUpgradeJourney(home);
} finally {
  if (home) await rig.uninstall(home).catch(() => {});
}

const { verdict, reason } = judgeUpgradeJourney(result);
report(verdict, reason);
process.exit(verdict === "fail" ? 1 : 0);

// ---------------------------------------------------------------------------

function report(outcome, detail) {
  console.log(
    `[install-upgrade-lifecycle] ${outcome.toUpperCase()}: ${detail}`
  );
  if (outcome === "skip") {
    console.log(`::warning::install-upgrade-lifecycle skipped — ${detail}`);
  } else if (outcome === "fail") {
    console.log(`::error::install-upgrade-lifecycle failed — ${detail}`);
  }
}
