import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const CREDENTIAL_ID_KEY = "centraid.v1.locker.device-credential-id";
const SECRET_KEY = "centraid.locker.device-secret";
const OPTIONS: SecureStore.SecureStoreOptions = {
  authenticationPrompt: "Authenticate for Locker",
  keychainAccessible: SecureStore.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  requireAuthentication: true,
};

export function lockerBiometricsSupported(): boolean {
  return SecureStore.canUseBiometricAuthentication();
}

export async function lockerDeviceCredentialId(): Promise<string | null> {
  return AsyncStorage.getItem(CREDENTIAL_ID_KEY);
}

export async function newLockerDeviceSecret(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

export async function storeLockerDeviceCredential(
  credentialId: string,
  secret: string
): Promise<void> {
  await SecureStore.setItemAsync(SECRET_KEY, secret, OPTIONS);
  const verified = await SecureStore.getItemAsync(SECRET_KEY, OPTIONS);
  if (verified !== secret) {
    await SecureStore.deleteItemAsync(SECRET_KEY, OPTIONS).catch(
      () => undefined
    );
    throw new Error("Locker could not verify the biometric credential.");
  }
  await AsyncStorage.setItem(CREDENTIAL_ID_KEY, credentialId);
}

export async function readLockerDeviceCredential(): Promise<{
  credentialId: string;
  secret: string;
} | null> {
  const credentialId = await lockerDeviceCredentialId();
  if (!credentialId) return null;
  const secret = await SecureStore.getItemAsync(SECRET_KEY, OPTIONS);
  if (!secret) return null;
  return { credentialId, secret };
}

export async function removeLockerDeviceCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(SECRET_KEY, OPTIONS).catch(() => undefined);
  await AsyncStorage.removeItem(CREDENTIAL_ID_KEY);
}
