// Which party kinds can hold a vault, and so can be shared with at all.
//
// A LEAF ON PURPOSE: this predicate has no imports, because `share-kit.ts`
// — its old home — reaches `window.centraid` and imports by `.ts` extension,
// neither of which survives `packages/client`'s declaration build. The rule is
// wanted by every seat; the transport around it is not (#903).
const PARTY_KINDS_THAT_HOLD_NO_VAULT: readonly string[] = ["agent", "animal"];

/** Unknown kinds pass: a row that cannot say is not a row that said no. */
export function isAddressablePartyKind(kind: unknown): boolean {
  if (typeof kind !== "string") return true;
  return !PARTY_KINDS_THAT_HOLD_NO_VAULT.includes(kind);
}
