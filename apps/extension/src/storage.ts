import type { PairingState } from './types.js';

const PAIRING_KEY = 'centraid.companion.v1.pairing';
const DEVICE_KEY = 'centraid.companion.v1.device-key';
const LOCKED_KEY = 'centraid.companion.v1.locked';

export async function loadPairing(): Promise<PairingState | undefined> {
  const values = await chrome.storage.local.get(PAIRING_KEY);
  const value = values[PAIRING_KEY];
  return value && typeof value === 'object' ? (value as PairingState) : undefined;
}

export async function savePairing(pairing: PairingState): Promise<void> {
  await chrome.storage.local.set({ [PAIRING_KEY]: pairing });
}

export async function loadDeviceKey(): Promise<string | undefined> {
  const values = await chrome.storage.local.get(DEVICE_KEY);
  return typeof values[DEVICE_KEY] === 'string' ? values[DEVICE_KEY] : undefined;
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
