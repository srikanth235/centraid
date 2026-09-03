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
