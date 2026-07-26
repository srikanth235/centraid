import * as DocumentPicker from 'expo-document-picker';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export async function pickRecoveryKit(): Promise<unknown | undefined> {
  const result = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets[0]) return undefined;
  const text = await new File(result.assets[0].uri).text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('That file is not valid recovery-kit JSON.');
  }
}

/**
 * The OS share sheet is the off-device boundary: iOS can save to Files/iCloud
 * or a password manager, and Android can choose a Storage Access Framework
 * destination. The ceremony still requires re-selection through the picker.
 */
export async function shareRecoveryKit(kit: unknown): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('The system share sheet is unavailable on this device.');
  }
  const file = new File(Paths.cache, 'centraid-recovery-kit.json');
  file.write(`${JSON.stringify(kit, null, 2)}\n`);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json' });
}
