import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNpmInstallArgs,
  defaultInstallPrefix,
  formatPostInstallMessage,
  minNodeMajorFromEngines,
  nodeVersionSatisfies,
  parseInstallArgs,
  rewriteWorkspaceDependencies,
  topologicalPublishOrder,
} from './pack-helpers.mjs';

test('rewriteWorkspaceDependencies maps workspace:* to versions and clears private', () => {
  const { packageJson, rewrote } = rewriteWorkspaceDependencies(
    {
      name: '@centraid/gateway',
      private: true,
      dependencies: {
        '@centraid/protocol': 'workspace:*',
        sharp: '^0.35.3',
      },
      devDependencies: {
        typescript: 'catalog:',
      },
      scripts: { prepack: 'bun run build', test: 'vitest' },
    },
    { '@centraid/protocol': '0.1.0' },
  );
  assert.equal(packageJson.private, false);
  assert.equal(packageJson.dependencies['@centraid/protocol'], '0.1.0');
  assert.equal(packageJson.dependencies.sharp, '^0.35.3');
  assert.equal(packageJson.devDependencies, undefined);
  assert.equal(packageJson.scripts?.prepack, undefined);
  assert.equal(packageJson.scripts?.test, 'vitest');
  assert.deepEqual(packageJson.publishConfig, { access: 'public' });
  assert.ok(rewrote.includes('dependencies:@centraid/protocol'));
});

test('rewriteWorkspaceDependencies throws on missing workspace package', () => {
  assert.throws(
    () =>
      rewriteWorkspaceDependencies(
        { name: '@centraid/x', dependencies: { '@centraid/missing': 'workspace:*' } },
        {},
      ),
    /No published version/,
  );
});

test('topologicalPublishOrder places deps before dependents', () => {
  const pkgs = {
    protocol: { name: '@centraid/protocol', version: '0.1.0', dependencies: {} },
    gateway: {
      name: '@centraid/gateway',
      version: '0.1.0',
      dependencies: { '@centraid/protocol': 'workspace:*' },
    },
  };
  const order = topologicalPublishOrder(['gateway', 'protocol'], (dir) => pkgs[dir]);
  assert.deepEqual(order, ['protocol', 'gateway']);
});

test('parseInstallArgs reads OpenClaw-like flags', () => {
  const a = parseInstallArgs([
    '--prefix',
    '/tmp/c',
    '--version',
    '0.1.0',
    '--from-pack-dir',
    './packs',
    '--dry-run',
    '--with-service',
  ]);
  assert.equal(a.prefix, '/tmp/c');
  assert.equal(a.global, false);
  assert.equal(a.version, '0.1.0');
  assert.equal(a.fromPackDir, './packs');
  assert.equal(a.dryRun, true);
  assert.equal(a.withService, true);
});

test('parseInstallArgs rejects unknown flags', () => {
  assert.throws(() => parseInstallArgs(['--docker']), /Unknown flag/);
});

test('buildNpmInstallArgs registry vs pack dir', () => {
  assert.deepEqual(buildNpmInstallArgs({ version: '0.2.0', fromPackDir: null }), [
    '@centraid/gateway@0.2.0',
  ]);
  assert.deepEqual(
    buildNpmInstallArgs({
      version: 'latest',
      fromPackDir: '/packs',
      packFiles: ['/packs/a.tgz', '/packs/b.tgz'],
    }),
    ['/packs/a.tgz', '/packs/b.tgz'],
  );
  assert.throws(
    () => buildNpmInstallArgs({ version: 'latest', fromPackDir: '/empty', packFiles: [] }),
    /No pack tarballs/,
  );
});

test('formatPostInstallMessage never implies silent service', () => {
  const msg = formatPostInstallMessage({
    bin: 'centraid-gateway',
    prefix: '/home/u/.centraid',
    withService: false,
  });
  assert.match(msg, /serve --data-dir/);
  assert.match(msg, /service install/);
  assert.match(msg, /Optional OS service/);
  assert.doesNotMatch(msg, /installed the OS service/i);
});

test('nodeVersionSatisfies and engines parse', () => {
  assert.equal(minNodeMajorFromEngines('>=22.5'), 22);
  assert.equal(nodeVersionSatisfies('v22.23.1', 22), true);
  assert.equal(nodeVersionSatisfies('v20.0.0', 22), false);
  assert.equal(defaultInstallPrefix('/Users/me'), '/Users/me/.centraid');
});
