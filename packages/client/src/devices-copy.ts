export const DEVICES_EMPTY_TITLE = "Only this device is enrolled";

export const DEVICES_EMPTY_BODY =
  "Pair a phone or a laptop to reach this vault from it.";

export function forgetDeviceMessage(surface: "browser" | "device"): string {
  return `This ${surface} drops its pairing, its offline copy, and its cached previews, and returns to onboarding. Your vault is untouched — the enrollment stays on its host until you revoke it from Vault → Where it lives.`;
}
