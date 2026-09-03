const PAIR_ERRORS: readonly (readonly [string, string])[] = [
  [
    "owner_vaults_only",
    "A device pairs only for its own owner — ask them to pair theirs.",
  ],
  ["vaults_required", "Choose at least one vault this device may reach."],
  ["vault_required", "Choose at least one vault this device may reach."],
  ["invalid_vault_ids", "Vault choice didn’t take — try again."],
  ["not_found", "One of the chosen vaults is gone — reload."],
  [
    "no_iroh_endpoint",
    "The vault host has no network identity yet — start it.",
  ],
  [
    "device_identity_required",
    "The vault host doesn’t recognize this device yet — reload.",
  ],
  [
    "owner_only",
    "Hosting this machine doesn’t make you that vault’s owner — only its owner can do this.",
  ],
];

export function pairErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  for (const [code, message] of PAIR_ERRORS) {
    if (raw.includes(code)) return message;
  }
  return raw;
}

const LAST_DEVICE_CODE = "last_device_confirmation_required";
const LAST_DEVICE_VAULT = /for\s+\\?"(?<vault>[^"\\]+)\\?";\s+type/u;

export function lastDeviceVault(err: unknown): string | undefined {
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw.includes(LAST_DEVICE_CODE)) return undefined;
  return LAST_DEVICE_VAULT.exec(raw)?.[1];
}
