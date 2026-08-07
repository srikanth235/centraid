// What Back up SAYS. Nothing here imports anything.
//
// Split out of `photos-backup.ts` because that module owns the run — hooks,
// transfers, react-native — and a sentence should be assertable without
// standing up a renderer to ask what it says.

/**
 * An original that lives in iCloud and has not come down to this device.
 *
 * Lives HERE, not in `device-media.ts`, because that module reaches for
 * expo-media-library and react-native the moment it is imported — and a string
 * every surface quotes should not drag a native module in behind it. The
 * dependency points this way round on purpose: copy has no imports, and the
 * modules that act import the copy.
 */
export const IN_CLOUD_MESSAGE = "in iCloud — not downloaded on this device";

/** The one line the status line shows when a run finishes with leftovers. */
export function inCloudMessage(count: number): string {
  return `${count} selected item${count === 1 ? " is" : "s are"} ${IN_CLOUD_MESSAGE}; still selected for retry.`;
}

/**
 * What Back up says when the selection has NO device copy to send.
 *
 * Backup moves bytes off THIS DEVICE, so it only has work for photographs with
 * a `localId`. A selection of vault-resident ones — which is every photograph
 * on a phone whose library arrived over the replica — filters to empty, and the
 * run then completed with no transfers and no leftovers, falling through to the
 * success haptic. The member selected photographs, pressed Back up, and got a
 * confirmation buzz for work that never happened.
 *
 * This is the sentence instead. It names the reason (already on the gateway),
 * not the mechanism (`localId`), because the reason is what makes the refusal
 * make sense — the photographs are safe, which is why there is nothing to do.
 *
 * Deliberately NOT `IN_CLOUD_MESSAGE`: that one is about Apple's iCloud and
 * means "we could not fetch these". This one means the opposite — the bytes are
 * safely on the member's own gateway and there is nothing left to send.
 */
export function nothingToBackUpMessage(selectedCount: number): string {
  return selectedCount === 1
    ? "That photograph is already on the gateway — there is no copy on this device to send."
    : "Those photographs are already on the gateway — there are no copies on this device to send.";
}
