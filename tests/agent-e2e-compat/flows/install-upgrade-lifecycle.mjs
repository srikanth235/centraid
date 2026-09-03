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
