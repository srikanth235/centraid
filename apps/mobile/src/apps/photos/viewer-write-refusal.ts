// The ONE refusal ladder every writing surface in the photo viewer climbs —
// the toolbar, the `···` menu, the info sheet and `PhotoLightbox`'s
// `writeReason` — so a device row cannot be told the vault is read-only when
// the truth is that the photograph is not in it yet.

import { READ_ONLY_SOURCE_REASON } from "../../kit/replica/row-provenance";

/** A device-only photograph nothing has backed up yet — the phone imported it
 *  but this seat has not pulled the row. NOT a read-only vault. */
export const NOT_IN_A_VAULT_YET_REASON =
  "This photograph is not in a vault yet.";

/** What a member is told when a caption they typed travels with the upload
 *  instead of landing now (#1014, R17). */
export const QUEUED_WITH_UPLOAD_NOTE = "Saved with the upload.";

/** The ONE refusal ladder every writing surface in the viewer climbs — the
 *  toolbar, the `···` menu and `PhotoLightbox`'s `writeReason` all read it, so
 *  a device row cannot be told the vault is read-only when the truth is that
 *  the photograph is not in it yet.
 *
 *  NO-VAULT-ROW BEATS READ-ONLY (#1014, R17). It used to be the other way
 *  round, and `canWrite` is a property of a VAULT row: a photograph this phone
 *  holds and no vault has yet carries no such row, so the flag is false and
 *  every device-only picture in the member's OWN vault was refused with "ask
 *  its owner for write access" — an owner who is them, about a vault that
 *  would take the write the moment the row arrived. */
export function viewerWriteRefusal(input: {
  writable: boolean;
  hasVaultAsset: boolean;
}): string | undefined {
  if (!input.hasVaultAsset) return NOT_IN_A_VAULT_YET_REASON;
  if (!input.writable) return READ_ONLY_SOURCE_REASON;
  return undefined;
}

/** Whether a refusal is the read-only one — the only one whose remedy is
 *  asking another member for access (#1014, R17). */
export function isReadOnlyRefusal(reason: string | undefined): boolean {
  return reason === READ_ONLY_SOURCE_REASON;
}
