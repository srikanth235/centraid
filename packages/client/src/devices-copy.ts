// Devices' cross-surface copy (#805).
//
// The roster is `react/screens/HouseholdScreen.tsx` on desktop and
// `screens/devices/Devices.tsx` on mobile; the forget-this-device confirm is
// desktop's alone but was written twice inside it (`react/shell/App.tsx` and
// `react/shell/routes/SettingsRoute.tsx`), once for a device and once for a
// browser, with two different lists of what gets dropped.

export const DEVICES_EMPTY_TITLE = "Only this device is enrolled";

/**
 * The empty body — one sentence, and the action is the "Pair a device" button
 * beside it. "Everything stays on your own machines" was the custody promise
 * arriving where no custody decision is being made; it belongs on the pairing
 * ceremony, which states it at the moment it is true.
 */
export const DEVICES_EMPTY_BODY =
  "Pair a phone or a laptop to reach this vault from it.";

/**
 * Dropping this surface's own enrollment.
 *
 * A destructive confirm, so it keeps full sentences — this is the risk
 * decision, and what survives the act is exactly what the member is deciding
 * about. What it no longer does is drift: the shell's version said "drops its
 * pairing" and Settings' said "drops its device key" for the same act on the
 * same key material, so the noun is now one and only the SURFACE varies.
 *
 * `surface` is the member's word for the thing in front of them — "device" in
 * the desktop shell, "browser" in the web PWA's settings.
 */
export function forgetDeviceMessage(surface: "browser" | "device"): string {
  // The pointer names the surface that actually holds the roster. Devices and
  // the census merged into one Vault surface in v11, so "Household → Devices"
  // named a page that no longer exists — a confirm that tells a member to go
  // somewhere they cannot get to is worse than one that says nothing.
  return `This ${surface} drops its pairing, its offline copy, and its cached previews, and returns to onboarding. Your vault is untouched — the enrollment stays on its host until you revoke it from Vault → Where it lives.`;
}
