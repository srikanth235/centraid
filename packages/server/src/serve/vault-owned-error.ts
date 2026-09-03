export class VaultOwnedError extends Error {
  constructor(readonly vaultId: string) {
    super(`vault "${vaultId}" already has an owner`);
    this.name = "VaultOwnedError";
  }
}
