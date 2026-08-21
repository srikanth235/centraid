import path from "node:path";
import { pathToFileURL } from "node:url";

import { onTestFinished } from "vitest";

import type {
  BuildGatewayOptions,
  BuiltGateway,
  GatewayPaths,
} from "@centraid/server";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";
import type { OpenVaultOptions, VaultDb } from "@centraid/vault";

const helpersDir = import.meta.dirname;

/**
 * Resolve a workspace package's TypeScript entry without requiring a prior
 * `tsc` build — vitest can transform the source directly. Dynamic package
 * imports of `@centraid/*` fail when `dist/` is absent.
 */
function workspaceSrc(packageName: string, entry = "index.ts"): string {
  return pathToFileURL(
    path.join(helpersDir, "..", "..", "packages", packageName, "src", entry)
  ).href;
}

export interface CreateTestVaultOptions extends OpenVaultOptions {
  /** Defaults to an on-disk pair so tests exercise the production SQLite posture. */
  inMemory?: boolean;
  /** Defaults true: most callers need the owner row and full bootstrapped schema. */
  bootstrap?: boolean;
  ownerName?: string;
}

export async function createTestVault(
  options: CreateTestVaultOptions = {}
): Promise<VaultDb> {
  const { bootstrapVault, openVaultDb } = await import(workspaceSrc("vault"));
  const {
    inMemory = false,
    bootstrap = true,
    ownerName = "Test owner",
    ...vaultOptions
  } = options;
  const dir = inMemory
    ? undefined
    : (vaultOptions.dir ?? (await tempDir("centraid-vault-test-")));
  // #656 Layer 4: open + bootstrap + register-the-close is one flow with one
  // home, `@centraid/test-kit/vault`. This factory only adds the root-suite
  // conveniences on top (in-memory default, auto temp dir, bootstrap opt-out).
  if (!bootstrap) {
    const bare = openVaultDb({ ...vaultOptions, ...(dir ? { dir } : {}) });
    onTestFinished(() => {
      bare.close();
    });
    return bare;
  }
  return bootstrappedVault<VaultDb, unknown>(
    {
      // The kit's only open knob is `dir`; the suite's other OpenVaultOptions
      // ride in through the injected opener rather than widening the kit.
      openVaultDb: (open) => openVaultDb({ ...vaultOptions, ...open }),
      bootstrapVault,
    },
    { ...(dir ? { dir } : {}), ownerName }
  ).db;
}

export interface BuildTestGatewayOptions extends Omit<
  BuildGatewayOptions,
  "paths"
> {
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
  options: BuildTestGatewayOptions = {}
): Promise<TestGateway> {
  const { buildGateway } = await import(workspaceSrc("gateway"));
  const {
    rootDir: providedRoot,
    paths: pathOverrides,
    ...gatewayOptions
  } = options;
  const rootDir = providedRoot ?? (await tempDir("centraid-gateway-test-"));
  const paths: GatewayPaths = {
    vaultDir: path.join(rootDir, "vault"),
    ...pathOverrides,
  };
  const gateway = await buildGateway({ ...gatewayOptions, paths });
  onTestFinished(async () => {
    await gateway.stop().catch(() => undefined);
  });
  return { gateway, paths, rootDir };
}
