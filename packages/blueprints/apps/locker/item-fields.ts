// WHICH ROWS ONE ITEM DRAWS, and which of them are sealed (README-Locker §5,
// "Field row with verbs"; §3, "a type is a set of sections and fields").
//
// Hoisted out of `components/Item.tsx` when the phone gained an item screen of
// its own: two seats drawing the same item from two derivations is exactly the
// drift `docs/blueprint-seats.md#one-computation` forbids, and the answer to
// "does a card have a security code row" is a product law, not a rendering
// detail. Pure — no JSX, no IO — so both renderers are adapters over it.
//
// The partition is the same one `draft.ts` uses on the way in (`SEALED_KEYS`):
// a row here is either metadata, shown plainly and needing no permit, or it is
// sealed, and its VALUE is absent until a permit puts it there.

import type { LockerDetail, LockerItemType } from "./types.ts";

/** One sealed row: the field a permit is minted for, its word, and the rule
 *  it carries where the shared sealed note is not specific enough. */
export interface SealedFieldRow {
  field: string;
  label: string;
  note?: string;
}

/** One metadata row. `copy` names the field for the copy outcome, and its
 *  absence is what says "this value is not worth a clipboard verb". */
export interface MetadataFieldRow {
  label: string;
  value: string;
  copy?: string;
}

/**
 * The sealed rows one type owns, in the order the screen draws them.
 *
 * An identity owns NONE: its fields are all metadata, which is why opening one
 * is what the permit authorises rather than any single field
 * (`format.primarySealedField` answers `item` for it).
 */
export function sealedFieldsFor(
  type: LockerItemType | string
): readonly SealedFieldRow[] {
  if (type === "card") {
    return [
      { field: "card_number", label: "Card number" },
      {
        field: "cvv",
        label: "Security code",
        note: "Three digits, sealed like any other secret.",
      },
    ];
  }
  if (type === "note") {
    return [
      {
        field: "content",
        label: "Note",
        note: "Sealed at rest, and deliberately not searched — a note routinely holds recovery codes.",
      },
    ];
  }
  if (type === "wifi") {
    return [
      {
        field: "password",
        label: "Network password",
        note: "Sealed · the network name is not.",
      },
    ];
  }
  if (type === "identity") return [];
  return [{ field: "password", label: "Password" }];
}

/**
 * The metadata rows one type owns. Plain values, no permit, and the screen
 * says that once at the top rather than on every line. Empty parts are
 * DROPPED rather than drawn as an em dash: a row with nothing in it is a
 * question the vault was never asked.
 */
export function metadataFieldsFor(
  detail: LockerDetail
): readonly MetadataFieldRow[] {
  const rows: MetadataFieldRow[] = [];
  if (detail.username) {
    rows.push({ label: "Username", value: detail.username, copy: "Username" });
  }
  if (detail.type === "identity") {
    if (detail.fullname) rows.push({ label: "Name", value: detail.fullname });
    if (detail.email) {
      rows.push({ label: "Email", value: detail.email, copy: "Email" });
    }
    if (detail.phone) rows.push({ label: "Phone", value: detail.phone });
    if (detail.address) rows.push({ label: "Address", value: detail.address });
  }
  if (detail.type === "card") {
    if (detail.cardholder) {
      rows.push({ label: "Cardholder", value: detail.cardholder });
    }
    if (detail.brand) rows.push({ label: "Brand", value: detail.brand });
  }
  if (detail.type === "wifi" && detail.network) {
    rows.push({ label: "Network", value: detail.network, copy: "Network" });
  }
  return rows;
}

/**
 * THE DOT RUN a sealed value is drawn as (README-Locker §5: "a letter-spaced
 * dot run in `ink2` when sealed").
 *
 * A FIXED length, deliberately: a run as long as the stored secret would leak
 * its length to anyone looking over a shoulder, and length is the one thing
 * about a password worth guessing at.
 */
export const SEALED_RUN = "••••••••••••••";
