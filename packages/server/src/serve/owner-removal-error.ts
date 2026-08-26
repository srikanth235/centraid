/*
 * Removing a person who still owns vaults would orphan them — refused.
 */

export class OwnerRemovalError extends Error {
  constructor(
    readonly ownerId: string,
    readonly ownedVaultIds: readonly string[]
  ) {
    super(
      `owner "${ownerId}" still owns vault${ownedVaultIds.length === 1 ? "" : "s"} ` +
        `${ownedVaultIds.join(", ")}; reassign or erase them first`
    );
    this.name = "OwnerRemovalError";
  }
}
