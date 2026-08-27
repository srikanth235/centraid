// THE WORDS THIS SEAT ADDS, and only those.
//
// Every sentence Locker shares across seats lives in the blueprint's §6/§7
// tables (`view-copy.ts`, `route-copy.ts`) and is imported verbatim. What is
// here is what is TRUE ON A PHONE AND NOWHERE ELSE — the device credential,
// the camera, the enrolment offer — because "a surface never teaches a
// different fact about the same control" governs facts, and where the fact
// differs by seat the words must differ with it
// (docs/blueprint-seats.md, "search is not one behaviour").
//
// THE REGISTER IS §7's. Words: item, reveal, conceal, permit, receipt,
// passphrase, device credential, alias, review, verdict, window. Never
// "master password", never "secure", never a reassurance adjective, and never
// a lock icon standing in for a sentence.

/** The lock wall's second way in, where one has been enrolled. */
export const DEVICE_UNLOCK = "Unlock with this device";

/** Enrolling and revoking. Both name the §7 word for what they act on. */
export const DEVICE_ENROL = "Enrol a device credential";
export const DEVICE_REVOKE = "Revoke it";

/** Why a device credential is a second way in rather than a replacement. */
export const DEVICE_NOTE =
  "A device credential is revocable and the passphrase is not · this phone holds a random secret, and the vault holds a verifier for it.";

/** The enrolment offer, on the list, once a session is open — enrolling needs
 *  one, so the offer cannot stand on the lock wall that asks for it. */
export const DEVICE_OFFER = "This phone can hold a device credential.";

/** The switcher mask. A hidden window ends the session at once; this is what
 *  the OS screenshots instead of a list of titles. */
export const MASKED_LABEL = "Locker is hidden while Centraid is away";

/** The camera, the one Locker act only the origin seat can perform. */
export const SCAN_SEED = "Scan a code";
export const SCAN_TITLE = "Point at the one-time-code square.";
export const SCAN_NOTE =
  "An otpauth square carries the seed itself · it is read here and sent with the item, never stored on this phone.";
export const SCAN_CANCEL = "Cancel";
export const SCAN_REFUSED =
  "The camera was not granted · paste the otpauth URI or the seed instead.";
export const SCAN_UNREADABLE = "That square is not an otpauth code.";
export const SCAN_GRANT = "Allow the camera";

/** The item screen's own words. On this seat the item is a ROUTE rather than a
 *  pane beside the list, so arriving on it is itself the gesture a permit
 *  authorises — the desktop's item pane has no equivalent moment to name. */
export const OPEN_ITEM_ACT = "Open it";
export const OPEN_ITEM_BODY = "This item is sealed until you ask for it.";
export const OUTSIDE_WINDOW =
  "This item is not in the window this device read.";
export const BACK_TO_ITEMS = "Items";

/** The two metadata verbs the item screen puts beside Edit. Both queue like
 *  any other metadata write; neither can carry a secret. */
export const STAR_ITEM = "Star";
export const UNSTAR_ITEM = "Remove the star";
export const TRASH_ITEM = "Move to trash";
