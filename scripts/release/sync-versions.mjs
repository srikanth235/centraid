#!/usr/bin/env node
/**
 * Single-source monorepo version → workspace package.jsons + mobile native
 * project numbers (issue #501 / #468 J6).
 *
 * Canonical string: root package.json `version`.
 * Native build number: major*1e6 + minor*1e3 + patch (version-core.cjs).
 *
 *   node scripts/release/sync-versions.mjs [--version X.Y.Z] [--dry-run]
 *
 * When --version is omitted, re-stamps natives/workspaces to match root.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const { nativeBuildNumber } = require(path.join(root, 'apps/mobile/src/version-core.cjs'));

/**
 * Patch Android build.gradle versionCode / versionName.
 */
export function patchAndroidVersions(gradleText, semver, buildNumber) {
  let next = gradleText.replace(/versionCode\s+\d+\b/, `versionCode ${buildNumber}`);
  next = next.replace(/versionName\s+"[^"]+"/, `versionName "${semver}"`);
  return {
    ok: next.includes(`versionCode ${buildNumber}`) && next.includes(`versionName "${semver}"`),
    detail: next === gradleText ? 'unchanged' : 'patched',
    text: next,
  };
}

/**
 * Patch iOS pbxproj MARKETING_VERSION / CURRENT_PROJECT_VERSION.
 */
export function patchIosPbxproj(pbxText, semver, buildNumber) {
  let next = pbxText.replace(
    /CURRENT_PROJECT_VERSION = \d+;/g,
    `CURRENT_PROJECT_VERSION = ${buildNumber};`,
  );
  next = next.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${semver};`);
  return {
    ok: /CURRENT_PROJECT_VERSION = \d+;/.test(next),
    detail: next === pbxText ? 'unchanged' : 'patched',
    text: next,
  };
}

/**
 * Patch Info.plist CFBundleVersion / CFBundleShortVersionString.
 */
export function patchInfoPlist(plistText, semver, buildNumber) {
  let next = plistText.replace(
    /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/,
    `$1${buildNumber}$2`,
  );
  next = next.replace(
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
    `$1${semver}$2`,
  );
  return {
    ok:
      next.includes(`<string>${buildNumber}</string>`) &&
      next.includes(`<string>${semver}</string>`),
    detail: next === plistText ? 'unchanged' : 'patched',
    text: next,
  };
}

function collectPackageJsons(rootDir) {
  const out = [path.join(rootDir, 'package.json')];
  for (const dir of ['packages', 'apps']) {
    const base = path.join(rootDir, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const p = path.join(base, name, 'package.json');
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

export function runSyncVersions({ rootDir = root, version, dryRun = false } = {}) {
  const rootPkgPath = path.join(rootDir, 'package.json');
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const prev = rootPkg.version;
  const ver = version || prev;
  if (!/^\d+\.\d+\.\d+$/.test(ver)) {
    throw new Error(`unparseable version ${ver}`);
  }
  const build = nativeBuildNumber(ver);

  /** @param {string} filePath @param {string} content */
  function write(filePath, content) {
    if (dryRun) return;
    writeFileSync(filePath, content);
  }

  const workspaces = [];
  for (const p of collectPackageJsons(rootDir)) {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (j.version === prev || p === rootPkgPath) {
      j.version = ver;
      write(p, JSON.stringify(j, null, 2) + '\n');
      workspaces.push(path.relative(rootDir, p));
    }
  }

  const gradlePath = path.join(rootDir, 'apps/mobile/android/app/build.gradle');
  const pbxPath = path.join(rootDir, 'apps/mobile/ios/Centraid.xcodeproj/project.pbxproj');
  const infoPath = path.join(rootDir, 'apps/mobile/ios/Centraid/Info.plist');
  const shareInfoPath = path.join(
    rootDir,
    'apps/mobile/ios/ShareExtension/ShareExtension-Info.plist',
  );

  const natives = {};
  if (existsSync(gradlePath)) {
    const r = patchAndroidVersions(readFileSync(gradlePath, 'utf8'), ver, build);
    write(gradlePath, r.text);
    natives.android = r.detail;
  }
  if (existsSync(pbxPath)) {
    const r = patchIosPbxproj(readFileSync(pbxPath, 'utf8'), ver, build);
    write(pbxPath, r.text);
    natives.iosPbx = r.detail;
  }
  if (existsSync(infoPath)) {
    const r = patchInfoPlist(readFileSync(infoPath, 'utf8'), ver, build);
    write(infoPath, r.text);
    natives.infoPlist = r.detail;
  }
  if (existsSync(shareInfoPath)) {
    const r = patchInfoPlist(readFileSync(shareInfoPath, 'utf8'), ver, build);
    write(shareInfoPath, r.text);
    natives.shareInfoPlist = r.detail;
  }

  return { prev, version: ver, build, dryRun, workspaces, natives };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  let version = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--version') version = args[++i];
    else if (args[i] === '--dry-run') dryRun = true;
  }
  try {
    const report = runSyncVersions({ version: version || undefined, dryRun });
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}
