import { onTestFinished } from "vitest";

/**
 * The only part of a vault handle this kit needs to own: the close that has to
 * happen whether the test passes, fails, or throws mid-setup.
 */
export interface ClosableVault {
  close: () => void;
}

/**
 * The two vault entry points, injected rather than imported.
 *
 * `@centraid/test-kit` must not depend on `@centraid/vault`: `@centraid/vault`
 * already depends on this package for its own tests, and turbo's `^typecheck`
 * / `^build` edges would become a cycle. Injection also keeps the helper usable
 * from `packages/vault`'s own suites, which import `../db.js` / `../bootstrap.js`
 * relatively and never through the package barrel.
 */
export interface VaultBootstrapApi<TDb extends ClosableVault, TBoot> {
  openVaultDb: (options?: { dir?: string }) => TDb;
  bootstrapVault: (
    db: TDb,
    options: { ownerName: string; vaultId?: string }
  ) => TBoot;
}

export interface BootstrappedVaultOptions {
  /** On-disk vault directory. Omitted means the in-memory posture. */
  dir?: string;
  /** Defaults to a fixed name so vault identity never varies between runs. */
  ownerName?: string;
  vaultId?: string;
  /**
   * Close when the current test finishes. Default true. Pass false only when
   * the handle must outlive the test that created it (a `beforeAll` fixture),
   * and then close it yourself — `onTestFinished` has no meaning outside a
   * running test.
   */
  autoClose?: boolean;
}

export interface BootstrappedVault<TDb extends ClosableVault, TBoot> {
  db: TDb;
  boot: TBoot;
  /** Idempotent: safe to call even when `autoClose` already ran. */
  close: () => void;
}

/**
 * Open a vault, bootstrap its owner, and close it exactly once.
 *
 * Never hand-roll `openVaultDb()` + `bootstrapVault()` + an `afterEach` close:
 * the close is the part that drifts — a setup that throws between the two calls
 * leaks the handle, and an on-disk vault leaks the SQLite files with it.
 * Registering the close at the moment the handle exists makes that
 * unrepresentable.
 */
export function bootstrappedVault<TDb extends ClosableVault, TBoot>(
  api: VaultBootstrapApi<TDb, TBoot>,
  options: BootstrappedVaultOptions = {}
): BootstrappedVault<TDb, TBoot> {
  const { dir, ownerName = "Test owner", vaultId, autoClose = true } = options;
  const db = api.openVaultDb(dir === undefined ? {} : { dir });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    db.close();
  };
  // Registered before bootstrap runs: a bootstrap that throws must still close
  // the handle it was handed.
  if (autoClose) onTestFinished(close);

  const boot = api.bootstrapVault(
    db,
    vaultId === undefined ? { ownerName } : { ownerName, vaultId }
  );
  return { db, boot, close };
}
