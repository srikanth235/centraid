#!/usr/bin/env node

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
  ok(
    /exposeInMainWorld\(['"]CentraidApi['"]/u.test(src),
    "preload exposes CentraidApi"
  );
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

const detached = path.join(desktop, "src/main/detached-gateway-core.ts");
ok(existsSync(detached), "detached-gateway-core.ts present (H2–H7 pure core)");

const rollout = path.join(desktop, "src/main/update-rollout-core.ts");
ok(existsSync(rollout), "update-rollout-core.ts present (I5/I6 pure core)");

process.exit(failed > 0 ? 1 : 0);
