import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { BuildGatewayOptions, BuiltGateway, GatewayPaths } from '@centraid/gateway';
import type { OpenVaultOptions, VaultDb } from '@centraid/vault';
import { tempDir } from './temp-dir.js';

export interface CreateTestVaultOptions extends OpenVaultOptions {
  /** Defaults to an on-disk pair so tests exercise the production SQLite posture. */
  inMemory?: boolean;
  /** Defaults true: most callers need the owner row and full bootstrapped schema. */
  bootstrap?: boolean;
  ownerName?: string;
}

export async function createTestVault(options: CreateTestVaultOptions = {}): Promise<VaultDb> {
  const { bootstrapVault, openVaultDb } = await import('@centraid/vault');
  const { inMemory = false, bootstrap = true, ownerName = 'Test owner', ...vaultOptions } = options;
  const dir = inMemory ? undefined : (vaultOptions.dir ?? (await tempDir('centraid-vault-test-')));
  const vault = openVaultDb({ ...vaultOptions, ...(dir ? { dir } : {}) });
  if (bootstrap) bootstrapVault(vault, { ownerName });
  onTestFinished(() => {
    vault.close();
  });
  return vault;
}

export interface BuildTestGatewayOptions extends Omit<BuildGatewayOptions, 'paths'> {
  rootDir?: string;
  paths?: Partial<GatewayPaths>;
}

export interface TestGateway {
  gateway: BuiltGateway;
  paths: GatewayPaths;
  rootDir: string;
}

/** Build the listener-free host-agnostic gateway with disposable paths. */
export async function buildTestGateway(
  options: BuildTestGatewayOptions = {},
): Promise<TestGateway> {
  const { buildGateway } = await import('@centraid/gateway');
  const { rootDir: providedRoot, paths: pathOverrides, ...gatewayOptions } = options;
  const rootDir = providedRoot ?? (await tempDir('centraid-gateway-test-'));
  const paths: GatewayPaths = {
    vaultDir: join(rootDir, 'vault'),
    prefsFile: join(rootDir, 'prefs.json'),
    ...pathOverrides,
  };
  const gateway = await buildGateway({ ...gatewayOptions, paths });
  onTestFinished(async () => {
    await gateway.stop().catch(() => undefined);
  });
  return { gateway, paths, rootDir };
}
