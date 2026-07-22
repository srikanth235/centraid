import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_PLATFORMS,
  auditNativeArtifacts,
  hostToPlatformId,
  nativeArtifactName,
  nativeArtifactNameForId,
  requiredNativePlatformIds,
} from './native-platforms.mjs';
import { collectNodeArtifacts, copyArtifacts } from './merge-native-artifacts.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('required native platforms cover linux, mac arm, windows x64', () => {
  const req = requiredNativePlatformIds();
  assert.deepEqual(req.sort(), ['darwin-arm64', 'linux-x64', 'win32-x64'].sort());
});

test('nativeArtifactName matches loader convention', () => {
  assert.equal(nativeArtifactName('linux', 'x64'), 'centraid-tunnel-native.linux-x64.node');
  assert.equal(nativeArtifactName('darwin', 'arm64'), 'centraid-tunnel-native.darwin-arm64.node');
  assert.equal(nativeArtifactName('win32', 'x64'), 'centraid-tunnel-native.win32-x64.node');
  assert.equal(nativeArtifactNameForId('darwin-arm64'), 'centraid-tunnel-native.darwin-arm64.node');
});

test('auditNativeArtifacts reports missing required', () => {
  const audit = auditNativeArtifacts(['centraid-tunnel-native.linux-x64.node']);
  assert.ok(audit.missingRequired.includes('centraid-tunnel-native.darwin-arm64.node'));
  assert.ok(audit.missingRequired.includes('centraid-tunnel-native.win32-x64.node'));
  assert.equal(audit.present.length, 1);
});

test('auditNativeArtifacts passes when all required present', () => {
  const files = requiredNativePlatformIds().map((id) => nativeArtifactNameForId(id));
  const audit = auditNativeArtifacts(files);
  assert.deepEqual(audit.missingRequired, []);
});

test('hostToPlatformId maps process-like hosts', () => {
  assert.equal(hostToPlatformId({ os: 'Linux', arch: 'x64' }), 'linux-x64');
  assert.equal(hostToPlatformId({ os: 'darwin', arch: 'arm64' }), 'darwin-arm64');
  assert.equal(hostToPlatformId({ os: 'Windows_NT', arch: 'x64' }), 'win32-x64');
  assert.equal(hostToPlatformId({ os: 'Haiku', arch: 'x64' }), null);
});

test('NATIVE_PLATFORMS ids are unique and stable shape', () => {
  const ids = NATIVE_PLATFORMS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of NATIVE_PLATFORMS) {
    assert.equal(p.id, `${p.platform}-${p.arch}`);
    assert.ok(p.runnerHint);
  }
});

test('collectNodeArtifacts + copyArtifacts merge flat and nested layouts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'centraid-native-merge-'));
  const from = path.join(tmp, 'from');
  const dest = path.join(tmp, 'dest');
  fs.mkdirSync(path.join(from, 'linux-x64'), { recursive: true });
  fs.writeFileSync(path.join(from, 'linux-x64', 'centraid-tunnel-native.linux-x64.node'), 'a');
  fs.writeFileSync(path.join(from, 'centraid-tunnel-native.darwin-arm64.node'), 'b');
  const sources = collectNodeArtifacts(from);
  assert.equal(sources.length, 2);
  const copied = copyArtifacts(sources, dest);
  assert.equal(copied.length, 2);
  assert.ok(fs.existsSync(path.join(dest, 'centraid-tunnel-native.linux-x64.node')));
  assert.ok(fs.existsSync(path.join(dest, 'centraid-tunnel-native.darwin-arm64.node')));
  fs.rmSync(tmp, { recursive: true, force: true });
});
