// @vitest-environment node

import { serve } from '@centraid/gateway';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { aesGcmKeyProtector, KeyStore } from '@centraid/vault';
import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startDesktopEmbeddedGateway } from './embedded-gateway.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

function pathsFor(root: string) {
  return {
    vaultDir: path.join(root, 'vault'),
    cacheDir: path.join(root, 'cache'),
    logsDir: path.join(root, 'gateway-logs'),
    modelCatalogFile: path.join(root, 'cache', 'model-catalog.json'),
    modelPricingFile: path.join(root, 'cache', 'model-pricing.json'),
    templatesCacheDir: path.join(root, 'cache', 'templates'),
  };
}

async function treeShape(root: string, relative = ''): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    result.push(`${entry.isDirectory() ? 'd' : 'f'}:${child}`);
    if (entry.isDirectory()) result.push(...(await treeShape(root, child)));
  }
  return result.sort();
}

function normalizeDynamicNames(entries: string[]): string[] {
  return [
    ...new Set(
      entries.map((entry) =>
        entry
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<vault-id>')
          .replace(/[0-9a-f]{40}/g, '<git-object>')
          .replace(/(apps\.git\/objects\/)[0-9a-f]{2}(?=\/|$)/, '$1<git-prefix>')
          .replace(/(apps\.git\/objects\/<git-prefix>\/)[0-9a-f]{38}$/, '$1<git-rest>')
          .replace(/[0-9a-f]{32}/g, '<wal-generation>')
          .replace(/\d{13}(?=\.(?:tick|seg)$)/g, '<tick-ms>')
          .replace(/\d{12}-\d{12}-<tick-ms>\.seg$/, '<wal-segment>.seg')
          .replace(/closed-\d{12}\.mrk$/, 'closed.mrk'),
      ),
    ),
  ].sort();
}

test('actual Electron embed and headless daemon produce identical complete trees', async () => {
  const desktopRoot = await tempDir('desktop-embedded-layout-');
  const headlessRoot = await tempDir('headless-layout-');
  roots.push(desktopRoot, headlessRoot);
  const protector = aesGcmKeyProtector(Buffer.alloc(32, 0x42));
  const desktop = await startDesktopEmbeddedGateway({
    dataDir: desktopRoot,
    paths: pathsFor(desktopRoot),
    keyStore: new KeyStore(path.join(desktopRoot, 'keys'), { protector }),
    token: 'desktop-layout-token',
    ownerEndpointId: 'desktop-device',
    initVaultName: 'Family',
  });
  desktop.vaults.current().walShipper?.tick();
  await desktop.close();

  const headless = await serve({
    initVaultName: 'Family',
    paths: { ...pathsFor(headlessRoot), dataDir: headlessRoot },
    keyStore: new KeyStore(path.join(headlessRoot, 'keys'), { protector }),
    token: 'headless-layout-token',
    hostDeviceEndpointId: 'desktop-device',
  });
  headless.vaults.current().walShipper?.tick();
  await headless.close();

  expect(normalizeDynamicNames(await treeShape(desktopRoot))).toEqual(
    normalizeDynamicNames(await treeShape(headlessRoot)),
  );
}, 15_000);
