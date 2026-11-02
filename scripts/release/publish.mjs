#!/usr/bin/env node
/**
 * D2 publish half — only after maintainer authorization.
 *
 *   node scripts/release/publish.mjs --version 0.2.1 --issue 501 \
 *     [--surfaces desktop,gateway-image] [--dry-run] [--beta] [--push]
 *
 * - Requires --issue N (governance commit suffix; refuse #0)
 * - Bumps the monorepo version via sync-versions.mjs (every workspace package
 *   that tracked it; the store build number is derived, never written)
 * - Records ship surface set (does not invent surface-local versions)
 * - Builds the release notes from the commits since the last tag
 * - Creates annotated tag vX.Y.Z (or vX.Y.Z-beta.N with --beta)
 * - Does NOT push unless --push is passed
 *
 * Tag push fans out to tag-triggered workflows. Mobile remains dispatch-opt-in.
 * Never bump version only to fix a failed build — rebuild / retry tag instead.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { commitsSinceLastTag, releaseNotes } from "./release-commits.mjs";
import {
  buildSurfaceMatrix,
  defaultShipSurfaceIds,
  resolveShipSurfaces,
} from "./surfaces.mjs";
import { runSyncVersions } from "./sync-versions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
let version = null;
let issue = null;
let dryRun = false;
let beta = false;
let doPush = false;
let betaN = 1;
/** @type {string[] | null} */
let shipIds = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--version") version = args[++i];
  else if (args[i] === "--issue") issue = args[++i];
  else if (args[i] === "--dry-run") dryRun = true;
  else if (args[i] === "--beta") beta = true;
  else if (args[i] === "--beta-n") betaN = Number(args[++i]);
  else if (args[i] === "--push") doPush = true;
  else if (args[i] === "--surfaces") {
    const raw = args[++i] ?? "";
    shipIds = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
}

if (!version || !/^\d+\.\d+\.\d+$/u.test(version)) {
  console.error(
    "usage: node scripts/release/publish.mjs --version X.Y.Z --issue N [--surfaces a,b] [--beta] [--dry-run] [--push]"
  );
  process.exit(2);
}
if (!issue || !/^\d+$/u.test(issue) || !/[1-9]/u.test(issue)) {
  console.error(
    "publish requires --issue N (real GitHub issue; #0 is forbidden)"
  );
  process.exit(2);
}

if (beta && (!Number.isSafeInteger(betaN) || betaN < 1)) {
  console.error("publish requires --beta-n to be a positive safe integer");
  process.exit(2);
}

const resolvedShip = shipIds ?? defaultShipSurfaceIds();
const shipResolved = resolveShipSurfaces(resolvedShip);
if (!shipResolved.ok) {
  console.error(shipResolved.error);
  process.exit(2);
}
const rootPkgPath = path.join(root, "package.json");
const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
const prev = rootPkg.version;
const tag = beta ? `v${version}-beta.${betaN}` : `v${version}`;
const shipManifest = {
  version,
  tag,
  issue: `#${issue}`,
  surfaces: resolvedShip,
  matrix: buildSurfaceMatrix({ shipIds: resolvedShip }),
  createdAt: new Date().toISOString(),
  note: "Monorepo stamps all packages; ship set is intent for which workflows must go green.",
};

function extractReleaseBody() {
  try {
    return releaseNotes(commitsSinceLastTag(root), version).trim();
  } catch {
    return `Centraid ${version}`;
  }
}

console.error(
  `publish ${prev} → ${version} tag ${tag} (#${issue}) surfaces=[${resolvedShip.join(",")}]${dryRun ? " (dry-run)" : ""}`
);

const syncReport = runSyncVersions({ rootDir: root, version, dryRun });
const body = extractReleaseBody();
const bodyPath = path.join(root, "artifacts", "release-body.md");
const shipPath = path.join(root, "artifacts", "release-ship.json");
if (!dryRun) {
  try {
    mkdirSync(path.dirname(bodyPath), { recursive: true });
    writeFileSync(bodyPath, body + "\n");
    writeFileSync(shipPath, JSON.stringify(shipManifest, null, 2) + "\n");
  } catch {
    /* optional */
  }
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        version,
        tag,
        prev,
        issue,
        surfaces: resolvedShip,
        shipManifest,
        syncReport,
        bodyPath,
        bodyPreview: body.slice(0, 200),
        mobileHint: resolvedShip.includes("mobile")
          ? "gh workflow run release.yml -f surfaces=mobile -f mobile_profile=preview -f mobile_platform=all -f mobile_submit=false"
          : undefined,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const commitMsg = `chore(release): ${version} (#${issue})`;
execFileSync("git", ["add", "--", ...syncReport.workspaces], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("git", ["commit", "-m", commitMsg], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("git", ["tag", "-a", tag, "-m", `Centraid ${tag}`], {
  cwd: root,
  stdio: "inherit",
});

if (doPush) {
  execFileSync("git", ["push", "origin", "HEAD"], {
    cwd: root,
    stdio: "inherit",
  });
  execFileSync("git", ["push", "origin", tag], { cwd: root, stdio: "inherit" });
} else {
  console.error(
    `tag ${tag} created locally. Push with: git push origin HEAD && git push origin ${tag}`
  );
}

if (resolvedShip.includes("mobile")) {
  console.error(
    "mobile is in the ship set — after tag push, dispatch:\n" +
      "  gh workflow run release.yml -f surfaces=mobile -f mobile_profile=preview -f mobile_platform=all -f mobile_submit=false"
  );
}

console.log(
  JSON.stringify(
    {
      version,
      tag,
      issue,
      surfaces: resolvedShip,
      bodyPath,
      shipPath,
      build: syncReport.build,
    },
    null,
    2
  )
);
