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

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const desktop = path.join(root, 'apps/desktop');
let failed = 0;

function ok(cond, msg) {
  if (cond) console.log(`PASS  ${msg}`);
  else {
    console.error(`FAIL  ${msg}`);
    failed++;
  }
}

const mainJs = path.join(desktop, 'dist/main.js');
const preload = path.join(desktop, 'dist/preload.cjs');
const renderer = path.join(desktop, 'dist/renderer/react-boot.js');
const builderYml = path.join(desktop, 'electron-builder.yml');
const preloadSrc = path.join(desktop, 'src/preload.ts');

ok(existsSync(mainJs), 'dist/main.js exists (packaged main entry)');
ok(existsSync(preload), 'dist/preload.cjs exists (preload bridge)');
ok(existsSync(renderer), 'dist/renderer/react-boot.js exists (renderer mounted bundle)');
ok(existsSync(builderYml), 'electron-builder.yml present');

if (existsSync(builderYml)) {
  const yml = readFileSync(builderYml, 'utf8');
  ok(yml.includes('appId: dev.centraid.desktop'), 'appId is dev.centraid.desktop (J5)');
  ok(yml.includes('target: dmg') || yml.includes('dmg'), 'macOS DMG target (I10)');
  ok(yml.includes('zip') || yml.includes('target: zip'), 'macOS ZIP target for updater (I10)');
  ok(yml.includes('perMachine: false') || yml.includes('nsis'), 'Windows NSIS per-user (I10)');
}

if (existsSync(preloadSrc)) {
  const src = readFileSync(preloadSrc, 'utf8');
  // Structural: every preload must expose CentraidApi; silent missing bridge
  // is the failure mode L2 calls out.
  ok(src.includes("exposeInMainWorld('CentraidApi'"), 'preload exposes CentraidApi');
  for (const key of ['getSettings', 'saveSettings', 'onGatewayChanged']) {
    ok(src.includes(key), `preload defines bridge key ${key}`);
  }
}

if (existsSync(preload)) {
  const cjs = readFileSync(preload, 'utf8');
  ok(cjs.includes('CentraidApi'), 'built preload still contains CentraidApi');
}

// Detached gateway pure core must ship (H2–H7)
const detached = path.join(desktop, 'src/main/detached-gateway-core.ts');
ok(existsSync(detached), 'detached-gateway-core.ts present (H2–H7 pure core)');

const rollout = path.join(desktop, 'src/main/update-rollout-core.ts');
ok(existsSync(rollout), 'update-rollout-core.ts present (I5/I6 pure core)');

process.exit(failed > 0 ? 1 : 0);
