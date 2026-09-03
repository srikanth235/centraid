// "Open elsewhere" (#821 §7–§8): hand ONE document's bytes, exactly as
// stored, to the operating system's own opener — the honest answer for a kind
// Docs cannot set, and the stage's Download sibling. The bytes are staged in
// the cache the same way Photos' share path stages its copy; nothing is
// converted and nothing extra rides along.
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { authHeader } from "../../lib/gateway";
import { EXPORT_FOLDER, exportName } from "./docs-export-name";
import type { MobileDriveDoc } from "./docs-projection";
import { decodeTextDataUri, docBytesUrl } from "./document-read-model";

export class DocumentBytesUnavailableError extends Error {
  constructor() {
    super(
      "The bytes of this document are not on this device and the gateway is out of reach."
    );
    this.name = "DocumentBytesUnavailableError";
  }
}

async function stageBytes(
  doc: MobileDriveDoc,
  gatewayBase: string | undefined,
  vaultId: string | undefined
): Promise<string> {
  const inline = decodeTextDataUri(doc.content_uri ?? null);
  if (inline !== null) {
    const file = new File(Paths.cache, EXPORT_FOLDER, exportName(doc.title));
    file.create({ intermediates: true, overwrite: true });
    file.write(inline);
    return file.uri;
  }
  const url = docBytesUrl(doc, gatewayBase, vaultId);
  if (!url) throw new DocumentBytesUnavailableError();
  const downloaded = await File.downloadFileAsync(
    url,
    new File(Paths.cache, EXPORT_FOLDER, exportName(doc.title)),
    { headers: authHeader(), idempotent: true }
  );
  return downloaded.uri;
}

/** Hand the file to the OS sheet. Throws with a member-readable message when
 *  the bytes cannot be had — the caller states it, never swallows it. */
export async function openElsewhere(
  doc: MobileDriveDoc,
  gatewayBase: string | undefined,
  vaultId: string | undefined
): Promise<void> {
  const uri = await stageBytes(doc, gatewayBase, vaultId);
  await Sharing.shareAsync(uri, {
    ...(doc.media_type ? { mimeType: doc.media_type } : {}),
    dialogTitle: doc.title,
  });
}
