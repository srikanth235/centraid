export const IN_CLOUD_MESSAGE = "in iCloud — not downloaded on this device";

export function inCloudMessage(count: number): string {
  return `${count} selected item${count === 1 ? " is" : "s are"} ${IN_CLOUD_MESSAGE}; still selected for retry.`;
}

export function nothingToBackUpMessage(selectedCount: number): string {
  return selectedCount === 1
    ? "That photograph is already on the gateway — there is no copy on this device to send."
    : "Those photographs are already on the gateway — there are no copies on this device to send.";
}
