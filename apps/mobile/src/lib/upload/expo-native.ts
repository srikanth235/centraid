// The device-only half of the uploader (#419 M0.4).
//
// Everything here imports a native module, so nothing under test may import
// this file — the drainer takes both of these by injection (the M0.2 lesson:
// a statically-imported native module breaks the vitest rig).

import { File, Paths } from 'expo-file-system';
import * as Legacy from 'expo-file-system/legacy';

import {
  assertGatewayMintedUploadUrl,
  type BackgroundTransferScope,
} from '../bridge/transfer-policy';
import type { FileSource, FileSourceOpener } from './file-source';
import type { PartPutter } from './uploader';

/**
 * Random-access reads over a local file. `FileHandle` seeks natively, so a
 * 4 GB video is hashed and sealed in 4 MiB windows without ever materializing.
 */
export const expoFileSource: FileSourceOpener = async (localUri: string): Promise<FileSource> => {
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

/**
 * PUT one sealed part through the native background transfer stack: on iOS a
 * background URLSession (`FileSystemSessionType.BACKGROUND`), on Android the
 * uploader is background-capable by default. This is the same mechanism the
 * WebView bridge's `transfer.putBackground` uses — reached directly here
 * rather than through the bridge, which is the WebView-facing door.
 *
 * `uploadAsync` uploads from a file path, so the sealed part is spooled to the
 * cache directory first. Bytes are written raw (no base64 round-trip), which
 * is why this does not inherit the bridge's 24 MiB base64 cap.
 */
export function expoPartPutter(scope: BackgroundTransferScope): PartPutter {
  return async ({ url, body, transferId }) => {
    // Defence in depth: the drainer already pinned this URL, but nothing
    // reaches the native uploader without the gateway having minted it.
    const target = await assertGatewayMintedUploadUrl(url, scope);
    const spool = new File(Paths.cache, `centraid-upload-${transferId}.cbsf`);
    if (spool.exists) spool.delete();
    spool.create();
    spool.write(body);
    try {
      const response = await Legacy.uploadAsync(target.toString(), spool.uri, {
        httpMethod: 'PUT',
        uploadType: Legacy.FileSystemUploadType.BINARY_CONTENT,
        sessionType: Legacy.FileSystemSessionType.BACKGROUND,
        headers: { 'content-type': 'application/octet-stream' },
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`provider refused part ${transferId} (${response.status})`);
      }
      return etagOf(response.headers);
    } finally {
      try {
        spool.delete();
      } catch {
        // A leftover spool file is reclaimed by the OS cache sweeper.
      }
    }
  };
}

function etagOf(headers: Record<string, string> | undefined): string | null {
  if (!headers) return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'etag') return value;
  }
  return null;
}
