/*
 * Reading the gateway's device-screen refusals in plain words (issue #726).
 *
 * `readJson` folds the gateway's JSON error body into the thrown message, so
 * the machine-readable code arrives embedded rather than as a field. These
 * helpers read it back out here rather than teach every screen to parse HTTP
 * bodies. Two distinct refusals live in this one module because both surface
 * on the same cards (DevicesCard/DeviceRow/DevicePairPanel):
 *
 *   pairErrorMessage — a ticket mint that ownership refused. Access is
 *     ownership (#726): the only ticket a device may mint is for its OWN
 *     owner, so every refusal here is some flavor of "not yourself" — plus
 *     `owner_only` (#726 P1), the host-custody refusal for acting on a
 *     vault the host doesn't own.
 *   lastDeviceVault  — revoking the owner's LAST live device for a vault.
 *     The gateway names the vault it would strand and asks for a typed
 *     confirmation (`confirmLastDevice`) rather than counting anything
 *     client-side.
 */

const PAIR_ERRORS: readonly (readonly [string, string])[] = [
  [
    "owner_vaults_only",
    "You can only pair a device for yourself. Ask that person to pair their own device — adding someone else is arriving in a later release.",
  ],
  ["vaults_required", "Choose at least one vault this device may reach."],
  ["vault_required", "Choose at least one vault this device may reach."],
  [
    "invalid_vault_ids",
    "Something went wrong choosing vaults for this ticket. Try again.",
  ],
  [
    "not_found",
    "One of the chosen vaults is no longer available. Reload and try again.",
  ],
  [
    "no_iroh_endpoint",
    "The gateway has no network identity yet. Start it and try again.",
  ],
  [
    "device_identity_required",
    "This device isn’t recognized by the gateway yet. Reload and try again.",
  ],
  [
    "owner_only",
    "Hosting this machine doesn’t make you that vault’s owner — only its owner can do this.",
  ],
];

/** Turn a mint failure into something a person can act on. */
export function pairErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [code, message] of PAIR_ERRORS) {
    if (raw.includes(code)) return message;
  }
  return raw;
}

/*
 * The gateway refuses to strand a vault with no live device: revoking the
 * owner's last live device for a vault 409s until the caller echoes that
 * vault's name back in `confirmLastDevice`. It names the vault inside the
 * refusal (JSON-quoted), so the surface can escalate its confirm in place
 * instead of making the owner retype anything.
 */
const LAST_DEVICE_CODE = "last_device_confirmation_required";
const LAST_DEVICE_VAULT = /for\s+\\?"(?<vault>[^"\\]+)\\?";\s+type/u;

/** The vault that would lose its last live device, or `undefined` for other errors. */
export function lastDeviceVault(err: unknown): string | undefined {
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw.includes(LAST_DEVICE_CODE)) return undefined;
  return LAST_DEVICE_VAULT.exec(raw)?.[1];
}
