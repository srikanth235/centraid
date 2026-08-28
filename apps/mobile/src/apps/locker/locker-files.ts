// Both file doors carry plaintext; no copy may outlive the act.

import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { IMPORT_TOO_LARGE, IMPORT_UNREADABLE } from "./locker-seat-copy";

/** Cache, never documents. */
const LOCKER_FILES = "locker-files";

/** One JSON string in a phone's heap: refuse by size, not by OOM. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export interface PickedImportFile {
  filename: string;
  text: string;
}

export class ImportFileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileRefusedError";
  }
}

export async function pickLockerImportFile(): Promise<PickedImportFile | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    type: ["text/csv", "text/comma-separated-values", "text/plain"],
  });
  if (picked.canceled) return null;
  const asset = picked.assets[0];
  if (!asset) return null;
  if ((asset.size ?? 0) > IMPORT_MAX_BYTES) {
    void discardPickedFile(asset.uri);
    throw new ImportFileRefusedError(IMPORT_TOO_LARGE);
  }
  const file = new File(asset.uri);
  let text: string;
  try {
    text = await file.text();
  } catch {
    void discardPickedFile(asset.uri);
    throw new ImportFileRefusedError(IMPORT_UNREADABLE);
  }
  void discardPickedFile(asset.uri);
  return { filename: asset.name, text };
}

function discardPickedFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Best effort.
  }
}

export async function handOffLockerExport(
  name: string,
  csv: string
): Promise<void> {
  const file = new File(Paths.cache, LOCKER_FILES, name);
  file.create({ intermediates: true, overwrite: true });
  file.write(csv);
  try {
    await Sharing.shareAsync(file.uri, {
      dialogTitle: name,
      mimeType: "text/csv",
    });
  } finally {
    // A cancelled share sheet does not leave the vault's plaintext in cache.
    try {
      if (file.exists) file.delete();
    } catch {
      // Best effort.
    }
  }
}
