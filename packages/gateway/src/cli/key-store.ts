import { aesGcmKeyProtector, KeyStore } from '@centraid/vault';

/** Build the daemon KeyStore from the optional desktop-custodied wrapping key. */
export function daemonKeyStore(
  keysDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    warn?: (message: string) => void;
  } = {},
): KeyStore {
  const env = options.env ?? process.env;
  const encoded = env.CENTRAID_KEYSTORE_MASTER_KEY?.trim();
  const wrappingKey = encoded ? Buffer.from(encoded, 'base64') : undefined;
  if (wrappingKey && wrappingKey.length !== 32) {
    throw new Error('CENTRAID_KEYSTORE_MASTER_KEY must be one base64-encoded 32-byte key');
  }
  return new KeyStore(keysDir, {
    ...(wrappingKey ? { protector: aesGcmKeyProtector(wrappingKey) } : {}),
    ...(options.warn ? { warn: options.warn } : {}),
  });
}
