// A TYPE IS A SET OF SECTIONS AND FIELDS (README-Locker §3), as a value.
//
// This is the whole of what "type-aware" means on the add / edit screen: the
// type chip is the FIRST control and it decides the rows under it, so a card
// is never asked for a username and a Wi-Fi network is never asked for a card
// number. Because the set is data rather than a chain of conditionals, a type
// the vault gains later is one row in `TYPE_FIELDS` — which is the shape the
// prioritised expansion (GAPS §3.3 #1) needs, and the reason an unknown type
// degrades to a note with custom fields rather than to nothing.
//
// AND THE SEALED ROUND TRIP. An edit pre-fills metadata plainly and every
// sealed field with `SEALED` — the vault's own placeholder, which
// `locker.edit_item` reads as UNCHANGED (packages/vault commands/locker.ts,
// `isPlaceholder`). That is why an edit can save a title without the member
// re-typing a password they never revealed, and why the form never has to
// hold a secret it was not given.

import type { ItemDraftSeed, LockerDetail, LockerItemType } from "./types.ts";
import type { ItemDraft } from "./writes.ts";

/**
 * The vault's round-trip placeholder for a sealed value (issue #293). Sent
 * back unchanged, it means "leave the stored secret alone"; it is NEVER a
 * value, and nothing in this app ever displays it as one.
 */
export const SEALED = "«sealed»";

/** How one field is entered. `secret` masks and never autocompletes; `long`
 *  is a note's body; `otp` takes a seed or an otpauth URI. */
export type DraftFieldKind = "text" | "secret" | "long" | "otp";

export interface DraftField {
  /** The action's own input key (app.json → actions.add-item.input). */
  key: string;
  label: string;
  kind: DraftFieldKind;
  /** The rule this row carries, in the app's own words. */
  note?: string;
  /** Read in the numeric register — an expiry, a card number. */
  numeric?: boolean;
}

/** Every field whose value is sealed at rest — the same five columns the
 *  single-item read unseals (`queries/item.ts`). */
export const SEALED_KEYS: ReadonlySet<string> = new Set([
  "password",
  "otp_seed",
  "card_number",
  "cvv",
  "content",
]);

/**
 * The rows each type owns, in the order the form draws them. The notes are
 * `route-copy.ts`'s, attached at render rather than here, so this table stays
 * the STRUCTURE and the words stay in one file.
 */
export const TYPE_FIELDS: Readonly<
  Record<LockerItemType, readonly DraftField[]>
> = {
  login: [
    { key: "username", label: "Username", kind: "text" },
    { key: "password", label: "Password", kind: "secret" },
    { key: "url", label: "Address", kind: "text" },
    { key: "otp_seed", label: "One-time code", kind: "otp" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  card: [
    { key: "cardholder", label: "Cardholder", kind: "text" },
    { key: "card_number", label: "Card number", kind: "secret", numeric: true },
    { key: "expiry", label: "Expiry", kind: "text", numeric: true },
    { key: "cvv", label: "Security code", kind: "secret", numeric: true },
    { key: "brand", label: "Brand", kind: "text" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  note: [
    { key: "content", label: "Note", kind: "long" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  identity: [
    { key: "fullname", label: "Name", kind: "text" },
    { key: "email", label: "Email", kind: "text" },
    { key: "phone", label: "Phone", kind: "text" },
    { key: "address", label: "Address", kind: "text" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  wifi: [
    { key: "network", label: "Network", kind: "text" },
    { key: "password", label: "Network password", kind: "secret" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
  password: [
    { key: "password", label: "Password", kind: "secret" },
    { key: "notes", label: "Memo", kind: "long" },
  ],
};

/** A note's body is sealed even though it is entered as prose — which is
 *  exactly why notes are deliberately unsearchable (README-Locker §3). */
export function isSealedField(field: DraftField): boolean {
  return SEALED_KEYS.has(field.key);
}

export function fieldsFor(type: LockerItemType): readonly DraftField[] {
  return TYPE_FIELDS[type] ?? TYPE_FIELDS.note;
}

/** The keys this type owns. The payload builder drops everything else, so a
 *  member who fills a login and then switches to Wi-Fi never sends the
 *  username they typed. */
export function allowedKeys(type: LockerItemType): string[] {
  return fieldsFor(type).map((field) => field.key);
}

/** Does the Address row's match policy apply? One type has an address a page
 *  is matched against; an identity's address is a postal one. */
export function carriesMatchPolicy(type: LockerItemType): boolean {
  return type === "login";
}

export function emptySeed(type: LockerItemType = "login"): ItemDraftSeed {
  return {
    mode: "new",
    type,
    title: "",
    tags: "",
    alias: "",
    urlMatchPolicy: "registrable-domain",
    fields: {},
  };
}

/**
 * Pre-fill from an item that is already open. Metadata travels as it is; a
 * SEALED field travels as the placeholder whether or not the member revealed
 * it, so an edit that touches nothing else leaves every secret exactly where
 * it was. A revealed value is deliberately NOT carried in: the form would
 * then hold a plaintext the member did not ask it to hold.
 */
export function seedFromDetail(detail: LockerDetail): ItemDraftSeed {
  const fields: Record<string, string> = {};
  for (const field of fieldsFor(detail.type)) {
    if (isSealedField(field)) {
      const held = (detail as unknown as Record<string, unknown>)[field.key];
      if (held != null && held !== "") fields[field.key] = SEALED;
      continue;
    }
    const value = (detail as unknown as Record<string, unknown>)[field.key];
    if (typeof value === "string" && value !== "") fields[field.key] = value;
  }
  return {
    mode: "edit",
    itemId: detail.item_id,
    type: detail.type,
    title: detail.title,
    tags: (detail.tags ?? []).join(", "),
    alias: "",
    urlMatchPolicy: detail.url_match_policy ?? "registrable-domain",
    fields,
  };
}

/** Switch the type without losing what the two types share. A title and a
 *  memo survive; a field the new type does not own is dropped rather than
 *  carried invisibly to the payload builder. */
export function retype(
  seed: ItemDraftSeed,
  type: LockerItemType
): ItemDraftSeed {
  const keep = new Set(allowedKeys(type));
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(seed.fields)) {
    if (keep.has(key)) fields[key] = value;
  }
  return { ...seed, type, fields };
}

/** The one field the form insists on. A title is what the list is; an item
 *  with none would be a row a member cannot find again. */
export function isReady(seed: ItemDraftSeed): boolean {
  return seed.title.trim().length > 0;
}

/** The seed, as the write door takes it. */
export function draftFrom(seed: ItemDraftSeed): ItemDraft {
  return {
    ...(seed.itemId ? { itemId: seed.itemId } : {}),
    type: seed.type,
    title: seed.title,
    tags: seed.tags,
    // The alias stays READ-ONLY on this form: the actions now forward it
    // (GAPS §3.3 #15), but no vault read serves it back, so the form has
    // nothing to pre-fill and no way to show what a typed value would
    // overwrite. An empty string is dropped by the write door, so an edit
    // never clears an existing binding.
    alias: "",
    ...(carriesMatchPolicy(seed.type)
      ? { urlMatchPolicy: seed.urlMatchPolicy }
      : {}),
    fields: seed.fields,
    allowedKeys: allowedKeys(seed.type),
  };
}
