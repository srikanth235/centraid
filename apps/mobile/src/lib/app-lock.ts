import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const ENABLED_KEY = "centraid.v1.mobile.app-lock.enabled";
const GATE_KEY = "centraid.mobile.app-lock.gate";
const OPTIONS: SecureStore.SecureStoreOptions = {
  authenticationPrompt: "Unlock Centraid",
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  requireAuthentication: true,
};

export function canUseAppLock(): boolean {
  return SecureStore.canUseBiometricAuthentication();
}

export async function appLockEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY)) === "1";
}

export async function enableAppLock(): Promise<void> {
  if (!canUseAppLock())
    throw new Error(
      "Set up Face ID, Touch ID, or fingerprint authentication on this device first."
    );
  const gate = Crypto.randomUUID();
  await SecureStore.setItemAsync(GATE_KEY, gate, OPTIONS);
  const verified = await SecureStore.getItemAsync(GATE_KEY, OPTIONS);
  if (verified !== gate) {
    await SecureStore.deleteItemAsync(GATE_KEY, OPTIONS).catch(() => undefined);
    throw new Error("Centraid could not verify the biometric app lock.");
  }
  await AsyncStorage.setItem(ENABLED_KEY, "1");
}

export async function disableAppLock(): Promise<void> {
  await SecureStore.deleteItemAsync(GATE_KEY, OPTIONS);
  await AsyncStorage.removeItem(ENABLED_KEY);
}

export async function authenticateAppLock(): Promise<boolean> {
  return (await SecureStore.getItemAsync(GATE_KEY, OPTIONS)) !== null;
}
