// What Back up SAYS. Nothing here imports anything — assertable without a renderer.

/**
 * An original that lives in iCloud and has not come down to this device.
 * Lives HERE, not in `device-media.ts`: that module imports expo-media-library
 * the moment it is loaded.
 */
export const IN_CLOUD_MESSAGE = "in iCloud — not downloaded on this device";

export function inCloudMessage(count: number): string {
  return `${count} selected item${count === 1 ? " is" : "s are"} ${IN_CLOUD_MESSAGE}; still selected for retry.`;
}

/**
 * Selection has no device copy to send. Not `IN_CLOUD_MESSAGE`: that is
 * Apple's iCloud fetch miss; this means the bytes are already on the gateway.
 */
export function nothingToBackUpMessage(selectedCount: number): string {
  return selectedCount === 1
    ? "That photograph is already on the gateway — there is no copy on this device to send."
    : "Those photographs are already on the gateway — there are no copies on this device to send.";
}
