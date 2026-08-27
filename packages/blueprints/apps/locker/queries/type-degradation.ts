/**
 * The degradation rule (README-Locker §3, GAPS §3.3 #1), page-side.
 *
 * "A type is a set of sections and fields, so a type the vault does not have
 * yet degrades to a note with custom fields rather than to nothing." The vault
 * enforces its own list with a CHECK constraint; this is the READ side of the
 * same rule, and it exists because a vault restored from a newer build — or
 * one an assistant wrote an unfamiliar type into — must still RENDER. Every
 * type-specific value already lives in `locker_item_field`, so the only thing
 * an unrecognised type loses is the word on its chip.
 *
 * The list is a mirror of `LockerItemType` in `../types.ts`, which is itself
 * pinned to the schema's CHECK constraint by `locker-item-type.test.ts`.
 */

const KNOWN: ReadonlySet<string> = new Set([
  "login",
  "card",
  "note",
  "identity",
  "wifi",
  "password",
  "ssh_key",
  "api_credential",
  "passport",
  "bank_account",
  "driving_licence",
  "software_licence",
  "crypto_wallet",
  "membership",
  "document",
]);

export function isKnownType(type: string): boolean {
  return KNOWN.has(type);
}

/** An unknown type reads as a note. Its custom fields come through intact. */
export function degradeType(type: string): string {
  return KNOWN.has(type) ? type : "note";
}
