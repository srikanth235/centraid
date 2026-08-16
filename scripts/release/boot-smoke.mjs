#!/usr/bin/env node
/**
 * L2 / E3 — structural boot-the-artifact smoke (issue #468).
 *
 * Full packaged-app CDP attach needs electron-builder output + display.
 * This gate always runs on PRs and asserts the *packaged surface* is present:
 *   - desktop dist/main.js + preload.cjs + renderer/react-boot.js
 *   - preload bridge keys that CentraidApi must expose (parsed from source)
 *   - electron-builder.yml appId is dev.centraid.desktop
 *
 * When CENTRAID_PACKAGED_APP is set to a path, optionally spawn it
 * (future extension). Failure here means the artifact cannot boot.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const desktop = path.join(root, "apps/desktop");
let failed = 0;

function ok(cond, msg) {
  if (cond) console.log(`PASS  ${msg}`);
  else {
    console.error(`FAIL  ${msg}`);
    failed++;
  }
}

const mainJs = path.join(desktop, "dist/main.js");
const preload = path.join(desktop, "dist/preload.cjs");
const renderer = path.join(desktop, "dist/renderer/react-boot.js");
const builderYml = path.join(desktop, "electron-builder.yml");
const preloadSrc = path.join(desktop, "src/preload.ts");
// The bridge KEYS moved to the Electron-free core when preload.ts was split
// for testability (#656 Layer 1F); preload.ts keeps only the exposure call.
const preloadCoreSrc = path.join(desktop, "src/main/preload-core.ts");

ok(existsSync(mainJs), "dist/main.js exists (packaged main entry)");
ok(existsSync(preload), "dist/preload.cjs exists (preload bridge)");
ok(
  existsSync(renderer),
  "dist/renderer/react-boot.js exists (renderer mounted bundle)"
);
ok(existsSync(builderYml), "electron-builder.yml present");

if (existsSync(builderYml)) {
  const yml = readFileSync(builderYml, "utf8");
  ok(
    yml.includes("appId: dev.centraid.desktop"),
    "appId is dev.centraid.desktop (J5)"
  );
  ok(
    yml.includes("target: dmg") || yml.includes("dmg"),
    "macOS DMG target (I10)"
  );
  ok(
    yml.includes("zip") || yml.includes("target: zip"),
    "macOS ZIP target for updater (I10)"
  );
  ok(
    yml.includes("perMachine: false") || yml.includes("nsis"),
    "Windows NSIS per-user (I10)"
  );
  ok(
    yml.includes("AppImage") || yml.includes("linux:"),
    "Linux AppImage target (#501)"
  );
}

const desktopPkg = path.join(desktop, "package.json");
if (existsSync(desktopPkg)) {
  const pkg = JSON.parse(readFileSync(desktopPkg, "utf8"));
  ok(
    Boolean(pkg.devDependencies?.["electron-builder"]),
    "electron-builder pinned in desktop package.json"
  );
  // Runtime dep (packaged app loads it) — not a build-only devDependency.
  ok(
    Boolean(
      pkg.dependencies?.["electron-updater"] ||
      pkg.devDependencies?.["electron-updater"]
    ),
    "electron-updater pinned in desktop package.json"
  );
  ok(Boolean(pkg.scripts?.dist), "desktop dist script present");
}

ok(
  existsSync(path.join(root, "scripts/release/sync-versions.mjs")),
  "sync-versions.mjs present (#501)"
);
ok(
  existsSync(path.join(root, "scripts/release/restamp-rollout.mjs")),
  "restamp-rollout.mjs present (I8)"
);
ok(
  existsSync(path.join(root, "apps/mobile/eas.json")),
  "mobile eas.json present"
);
ok(
  existsSync(path.join(root, "apps/web/wrangler.json")),
  "web wrangler.json present (app.centraid.dev)"
);
ok(
  existsSync(path.join(root, "packages/server/Dockerfile")),
  "gateway Dockerfile present"
);

if (existsSync(preloadSrc)) {
  const src = readFileSync(preloadSrc, "utf8");
  // Structural: every preload must expose CentraidApi; silent missing bridge
  // is the failure mode L2 calls out.
  ok(
    /exposeInMainWorld\(['"]CentraidApi['"]/u.test(src),
    "preload exposes CentraidApi"
  );
  // Look for the keys wherever the bridge is actually defined: the core when
  // it exists, otherwise preload.ts itself. Checking only preload.ts would
  // have silently passed once the definitions moved out of it.
  const bridgeSrc = existsSync(preloadCoreSrc)
    ? readFileSync(preloadCoreSrc, "utf8")
    : src;
  for (const key of ["getSettings", "saveSettings", "onGatewayChanged"]) {
    ok(bridgeSrc.includes(key), `preload defines bridge key ${key}`);
  }
}

if (existsSync(preload)) {
  const cjs = readFileSync(preload, "utf8");
  ok(cjs.includes("CentraidApi"), "built preload still contains CentraidApi");
}

// Detached gateway pure core must ship (H2–H7)
const detached = path.join(desktop, "src/main/detached-gateway-core.ts");
ok(existsSync(detached), "detached-gateway-core.ts present (H2–H7 pure core)");

const rollout = path.join(desktop, "src/main/update-rollout-core.ts");
ok(existsSync(rollout), "update-rollout-core.ts present (I5/I6 pure core)");

process.exit(failed > 0 ? 1 : 0);
