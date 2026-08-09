/*
 * Split out of `enrollment-store.ts` (one class per file —
 * `max-classes-per-file`): enrolling into a vault someone else owns is
 * refused, never a transfer.
 */

export class VaultOwnedError extends Error {
  constructor(readonly vaultId: string) {
    super(`vault "${vaultId}" already has an owner`);
    this.name = "VaultOwnedError";
  }
}
