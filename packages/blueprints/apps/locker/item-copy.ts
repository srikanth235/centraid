// The sidecar half of the §6 copy table (`view-copy.ts` and `route-copy.ts`
// hold the rest). THE REGISTER IS §7's: never "master password", never
// "secure", never "protected", never a reassurance adjective, no lock icon.

export const FIELDS_HEAD = "Fields";
export const FIELDS_META = "the item's own sections, as the vault sorted them";

/** Revealed through the OWNING ITEM's permit (#873) — same cost, same words
 *  as the item's own sealed columns. */

export const PLAIN_FIELD_NOTE = "Metadata · it never needed a permit.";

export const ADDRESSES_HEAD = "Addresses";
export const ADDRESSES_META = "the primary first, each with its match policy";
export const ADDRESS_OPEN = "Open";
export const MATCH_WORD: Readonly<Record<string, string>> = {
  "registrable-domain": "any host under the domain",
  "exact-host": "that host, and nowhere else",
};
export const ADDRESS_PRIMARY = "Primary";

export const PASSKEY_HEAD = "Passkey";
export const PASSKEY_META = "stored, not performed";
export const PASSKEY_KEY_HELD =
  "Key material is stored beside this slot, sealed like any other secret.";
export const PASSKEY_KEY_NONE =
  "No key material is stored · the slot is the metadata alone.";
export const PASSKEY_SINCE = "Added";
export const PASSKEY_KEY_ROW = "Key material";

/** THE HONEST BOUNDARY: sealing is a column class and a file is not a column,
 *  so "sealed" here would be a lie a member could not check. */
export const ATTACHMENTS_HEAD = "Attachments";
export const ATTACHMENTS_META = "what the file is, and how big";
export const ATTACHMENTS_NOTE =
  "These ride the vault file itself rather than the reveal gate · opening one costs no permit and writes no receipt.";

export const HISTORY_HEAD = "History";
export const HISTORY_META = "what changed, and when";
export const HISTORY_EMPTY = "Nothing has been rewritten yet.";
/** WHERE A ROTATED PASSWORD WENT (#916, D2). The pane used to offer it behind
 *  a permit; a revision is a snapshot now, its sealed cells stay sealed, and
 *  the only thing that opens them is the export — which is confirmed,
 *  receipted, and says out loud that it is a mass reveal. Saying so on the row
 *  is the honest answer to "so where is my old password". */
export const HISTORY_PASSWORD_PRESENT =
  "Previous password kept · sealed in this revision, and readable only through a confirmed export.";
export const PASSWORD_AGE_ROW = "Password age";
export const PASSWORD_AGE_NOTE =
  "Counted from the day it was set · Review scores the same clock, so the two can never disagree.";

export const LIFE_HEAD = "Life";
export const ARCHIVE = "Archive";
export const UNARCHIVE = "Unarchive";
export const DUPLICATE = "Duplicate";
export const ARCHIVE_NOTE =
  "Kept forever, out of the lists · not a trash, so nothing is scheduled to be purged.";
export const DUPLICATE_NOTE =
  "Clone-and-edit for a sibling account · the sealed values are copied inside the vault, and the alias is not carried over.";
export const ARCHIVED = "Archived · kept, and out of the lists";
export const UNARCHIVED = "Unarchived · back in the lists";
export const DUPLICATED =
  "Duplicated · the copy is titled the same, and “copy”";
export const ARCHIVED_ROW = "Archived";
export const ARCHIVED_YES = "Archived";
export const ARCHIVED_NO = "In the lists";

export const ARCHIVE_HEAD = "Archived";
export const ARCHIVE_META = "kept forever, and out of the default window";
export const ARCHIVE_EMPTY = "Nothing is archived.";
export const ARCHIVE_NOT_TRASH =
  "Nothing here has a purge date · archive and trash are opposite ends of the same axis.";

export const DEGRADED_ROW = "Stored type";
