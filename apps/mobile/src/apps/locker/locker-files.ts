// THE TWO FILE DOORS THIS SEAT HAS, and they are the phone's own.
//
// The browser seat reaches a file with `<input type="file">` and hands one back
// with `<a download>` over an object URL (`apps/locker/export-file.ts`). A phone
// has neither, so this module is the seat adapter for exactly those two acts —
// and nothing else. Every DECISION about the bytes is still shared: the CSV
// dialect and its name are `export-file.ts`'s, the verdicts are
// `import-model.ts`'s, and this file only moves the bytes across the boundary
// between the operating system and the gateway door.
//
// BOTH SIDES CARRY PLAINTEXT, so both sides clean up after themselves. A picked
// import file is the member's whole old password manager; an export is the
// whole of this vault. Neither is left sitting in the app's cache once it has
// been handed on — that is the one thing a phone can do here that a browser
// tab cannot, and it is why the delete is not optional.

import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { IMPORT_TOO_LARGE, IMPORT_UNREADABLE } from "./locker-seat-copy";

/** Where a staged import and a written export live for the moment they exist.
 *  Cache, never documents: nothing here is meant to survive the act. */
const LOCKER_FILES = "locker-files";

/**
 * The ceiling on a file this seat will read into memory and post as one body.
 *
 * A password-manager CSV of a few thousand logins is well under a megabyte; two
 * is generous. The number is here rather than at the border because the reason
 * is this seat's — the whole file becomes one JSON string in a phone's heap
 * before it is sent — and a refusal that names the size beats an out-of-memory
 * crash that names nothing.
 */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

export interface PickedImportFile {
  filename: string;
  text: string;
}

/** A refusal the Import surface is expected to render, not a crash. */
export class ImportFileRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileRefusedError";
  }
}

/**
 * Ask the operating system for one file and read it as text.
 *
 * `null` is a CANCEL — the member closed the sheet, which is not a refusal and
 * has nothing to say. A refusal throws with the sentence the surface prints.
 *
 * The picker's cache copy is deleted the moment its text is in hand: the copy
 * is a second plaintext of every secret the member owns, and it has no reason
 * to outlive the read.
 */
export async function pickLockerImportFile(): Promise<PickedImportFile | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    copyToCacheDirectory: true,
    multiple: false,
    // The border is the validator (it parses the header and routes by it), so
    // this list narrows the sheet rather than deciding anything.
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

/** Best-effort: a copy that cannot be deleted must not take the import down,
 *  and there is nothing a member could do about it if it did. */
function discardPickedFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Nothing to say and nothing to do — the read already succeeded or failed.
  }
}

/**
 * Write the export and hand it to the system sheet.
 *
 * The bytes are written, handed over, and deleted in one call: nothing keeps a
 * reference to them and no state anywhere records that they existed. Where the
 * member sends the file is their decision and outside the vault, which is what
 * `EXPORT_WHERE_NOTE` says on the surface above this call.
 */
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
    // A plaintext of every secret in the vault does not stay in a cache
    // directory because a share sheet was cancelled.
    try {
      if (file.exists) file.delete();
    } catch {
      // Same as above: best effort, and never in place of handing it over.
    }
  }
}
