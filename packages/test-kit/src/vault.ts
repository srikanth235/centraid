import { onTestFinished } from "vitest";

export interface ClosableVault {
  close: () => void;
}

export interface VaultBootstrapApi<TDb extends ClosableVault, TBoot> {
  openVaultDb: (options?: { dir?: string }) => TDb;
  bootstrapVault: (
    db: TDb,
    options: { ownerName: string; vaultId?: string }
  ) => TBoot;
}

export interface BootstrappedVaultOptions {
  dir?: string;
  ownerName?: string;
  vaultId?: string;
  autoClose?: boolean;
}

export interface BootstrappedVault<TDb extends ClosableVault, TBoot> {
  db: TDb;
  boot: TBoot;
  close: () => void;
}

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
  if (autoClose) onTestFinished(close);

  const boot = api.bootstrapVault(
    db,
    vaultId === undefined ? { ownerName } : { ownerName, vaultId }
  );
  return { db, boot, close };
}
