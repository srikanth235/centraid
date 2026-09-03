import { File, Paths, UploadType } from "expo-file-system";

import type { FileSource, FileSourceOpener } from "./file-source";
import { assertGatewayMintedUploadUrl } from "./transfer-policy";
import type { BackgroundTransferScope } from "./transfer-policy";
import type { PartPutter } from "./uploader";

export const expoFileSource: FileSourceOpener = async (
  localUri: string
): Promise<FileSource> => {
  const file = new File(localUri);
  if (!file.exists) throw new Error(`local file not found: ${localUri}`);
  const handle = file.open();
  const size = handle.size ?? file.size;
  return {
    size,
    async read(offset, length) {
      handle.offset = offset;
      return handle.readBytes(length);
    },
    close() {
      handle.close();
    },
  };
};

export function expoPartPutter(scope: BackgroundTransferScope): PartPutter {
  return async ({ url, body, transferId }) => {
    const target = await assertGatewayMintedUploadUrl(url, scope);
    const spool = new File(Paths.cache, `centraid-upload-${transferId}.cbsf`);
    if (spool.exists) spool.delete();
    spool.create();
    spool.write(body);
    try {
      const response = await spool.upload(target.toString(), {
        httpMethod: "PUT",
        uploadType: UploadType.BINARY_CONTENT,
        sessionType: "background",
        headers: { "content-type": "application/octet-stream" },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `provider refused part ${transferId} (${response.status})`
        );
      }
      return etagOf(response.headers);
    } finally {
      try {
        spool.delete();
      } catch {
        // Intentionally empty.
      }
    }
  };
}

function etagOf(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "etag") return value;
  }
  return null;
}
