import { tempDir } from '@centraid/test-kit/temp-dir';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { daemonLayoutFor } from '../cli/paths.js';
import { serve } from './serve.js';

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
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const objectId = /[0-9a-f]{40}/g;
  return entries
    .map((entry) =>
      entry
        .replace(uuid, '<vault-id>')
        .replace(objectId, '<git-object>')
        .replace(/(apps\.git\/objects\/)[0-9a-f]{2}(?=\/|$)/, '$1<git-prefix>')
        .replace(/(apps\.git\/objects\/<git-prefix>\/)[0-9a-f]{38}$/, '$1<git-rest>'),
    )
    .filter((entry) => !entry.startsWith('f:cache/'))
    .sort();
}

test('desktop embed and headless serve produce the same gateway tree', async () => {
  const desktopRoot = await tempDir('desktop-layout-');
  const headlessRoot = await tempDir('headless-layout-');
  const desktopLayout = daemonLayoutFor(desktopRoot);
  const headlessLayout = daemonLayoutFor(headlessRoot);

  const desktop = await serve({
    initVaultName: 'Family',
    hostDeviceEndpointId: 'desktop-device',
    paths: {
      prefsFile: desktopLayout.gatewayDbFile,
      vaultDir: desktopLayout.vaultDir,
      cacheDir: desktopLayout.cacheDir,
      backupDir: desktopLayout.cacheDir,
      logsDir: desktopLayout.logsDir,
      storageDir: desktopLayout.dataDir,
      modelCatalogFile: desktopLayout.modelCatalogFile,
      modelPricingFile: desktopLayout.modelPricingFile,
      templatesCacheDir: desktopLayout.templatesCacheDir,
    },
  });
  await desktop.close();

  const headless = await serve({
    initVaultName: 'Family',
    paths: headlessLayout,
  });
  await headless.close();

  await Promise.all([
    fs.mkdir(desktopLayout.cacheDir, { recursive: true }),
    fs.mkdir(headlessLayout.cacheDir, { recursive: true }),
  ]);
  expect(normalizeDynamicNames(await treeShape(desktopRoot))).toEqual(
    normalizeDynamicNames(await treeShape(headlessRoot)),
  );
});
