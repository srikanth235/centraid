import { normalizePairingVaults } from "./pairing-vaults.js";
import type { PairingState } from "./types.js";

const PAIRING_KEY = "centraid.companion.v1.pairing";
const DEVICE_KEY = "centraid.companion.v1.device-key";
const LOCKED_KEY = "centraid.companion.v1.locked";

export async function loadPairing(): Promise<PairingState | undefined> {
  const values = await chrome.storage.local.get(PAIRING_KEY);
  const value = values[PAIRING_KEY];
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  // COMPAT(pair-ticket-multi-vault): added 2026-08-02, drop when floor >= pair-ticket-multi-vault-v1
  const vaults = normalizePairingVaults(raw);
  if (vaults.length === 0) return undefined;
  const activeId =
    typeof raw["vaultId"] === "string" &&
    vaults.some((vault) => vault.vaultId === raw["vaultId"])
      ? raw["vaultId"]
      : vaults[0]!.vaultId;
  const active = vaults.find((vault) => vault.vaultId === activeId);
  return {
    ...(raw as unknown as PairingState),
    vaultId: activeId,
    ...(active?.vaultName ? { vaultName: active.vaultName } : {}),
    vaults,
  };
}

export async function savePairing(pairing: PairingState): Promise<void> {
  await chrome.storage.local.set({ [PAIRING_KEY]: pairing });
}

/** Change only the active vault; the device enrollment remains shared. */
export async function selectPairingVault(
  vaultId: string
): Promise<PairingState | undefined> {
  const pairing = await loadPairing();
  const vault = pairing?.vaults.find(
    (candidate) => candidate.vaultId === vaultId
  );
  if (!pairing || !vault) return undefined;
  const next: PairingState = {
    ...pairing,
    vaultId: vault.vaultId,
    ...(vault.vaultName ? { vaultName: vault.vaultName } : {}),
  };
  await savePairing(next);
  return next;
}

export async function loadDeviceKey(): Promise<string | undefined> {
  const values = await chrome.storage.local.get(DEVICE_KEY);
  return typeof values[DEVICE_KEY] === "string"
    ? values[DEVICE_KEY]
    : undefined;
}

export async function saveDeviceKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [DEVICE_KEY]: key });
}

export async function isLocked(): Promise<boolean> {
  const values = await chrome.storage.session.get(LOCKED_KEY);
  return values[LOCKED_KEY] === true;
}

export async function setLocked(locked: boolean): Promise<void> {
  await chrome.storage.session.set({ [LOCKED_KEY]: locked });
}

export async function purgeCompanionState(): Promise<void> {
  await Promise.all([
    chrome.storage.local.remove([PAIRING_KEY, DEVICE_KEY]),
    chrome.storage.session.remove(LOCKED_KEY),
  ]);
}
