/*
 * THE SENDER'S HALF OF CHUNKING (#1020 wave 4 lane extension, D-1020-X3).
 *
 * Native messaging has a **1 MiB ceiling per message from an extension** and no
 * streaming (census §E seam 2). A page capture is routinely larger — a 2× PNG of
 * a tall page is a few megabytes — so a frame that would not fit is not sent:
 * the extension opens a staging session, sends the bytes as frames that do fit,
 * and closes it.
 *
 * This module is the planning half and holds no `chrome.*`: it decides whether a
 * payload needs staging, splits it, and encodes each window. The assembler is
 * `crates/centraid/src/cmd/native_host/stage.rs`, and the two agree on the split
 * because both compute it from `chunkCount` / `chunk_count` over the same
 * constant — which the host also answers in `stage:begin`, so a disagreement is
 * caught before the first chunk rather than at the digest check.
 */

import { MAX_FRAME_BYTES } from "./methods.js";

/**
 * How many raw bytes ride one chunk frame.
 *
 * 512 KiB, matching `stage::MAX_CHUNK_BYTES`. Base64 inflates by 4/3, so a
 * 512 KiB window is about 683 KiB of text and the JSON envelope around it fits
 * comfortably under the browser's 1 MiB ceiling. The margin is taken here rather
 * than discovered at 1,048,577 bytes.
 */
export const CHUNK_BYTES = 512 * 1024;

/**
 * The largest payload that rides one ordinary frame.
 *
 * Below this an inline frame is simpler and one round trip instead of N + 2.
 * The bound is the ceiling with room for the method's own fields, taken
 * conservatively: base64 of the payload plus the envelope must fit, so the raw
 * size that is safe inline is three quarters of the ceiling minus a margin.
 */
export const MAX_INLINE_BYTES =
  Math.floor((MAX_FRAME_BYTES * 3) / 4) - 16 * 1024;

/** How many chunks a payload of this size takes. */
export function chunkCount(byteSize: number): number {
  if (byteSize <= 0) return 0;
  return Math.ceil(byteSize / CHUNK_BYTES);
}

/** Whether a payload of this size must be staged rather than inlined. */
export function needsStaging(byteSize: number): boolean {
  return byteSize > MAX_INLINE_BYTES;
}

/** Base64 of a byte window, without a data URI prefix. */
export function encodeChunk(bytes: Uint8Array): string {
  // Chunked into 32 KiB pieces before `String.fromCharCode`: spreading a
  // 512 KiB array into an argument list overflows the call stack in every
  // engine, and the failure looks like a corrupt capture rather than a crash.
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32 * 1024) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 32 * 1024));
  }
  return btoa(binary);
}

/** The bytes of a `data:` URI, or `undefined` when it is not one. */
export function dataUriBytes(
  uri: string,
  expectedMediaType?: string
): { bytes: Uint8Array; mediaType: string } | undefined {
  const match = /^data:(?<mediaType>[^;,]+);base64,(?<payload>.*)$/su.exec(uri);
  if (!match) return undefined;
  const mediaType = match.groups!["mediaType"]!;
  if (expectedMediaType && mediaType !== expectedMediaType) return undefined;
  const binary = atob(match.groups!["payload"]!);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1)
    bytes[at] = binary.charCodeAt(at);
  return { bytes, mediaType };
}

/** The sha256 of some bytes, lowercase hex, through the platform's own digest. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** One staging frame, ready to post. */
export type StageFrame =
  | {
      readonly t: "stage:begin";
      readonly media_type: string;
      readonly byte_size: number;
      readonly sha256: string;
    }
  | {
      readonly t: "stage:chunk";
      readonly staging_id: string;
      readonly seq: number;
      readonly bytes_b64: string;
    }
  | { readonly t: "stage:end"; readonly staging_id: string };

/** The chunk frames for one staging session, in order. */
export function chunkFrames(
  stagingId: string,
  bytes: Uint8Array
): StageFrame[] {
  const frames: StageFrame[] = [];
  for (let seq = 0; seq * CHUNK_BYTES < bytes.length; seq += 1) {
    frames.push({
      t: "stage:chunk",
      staging_id: stagingId,
      seq,
      bytes_b64: encodeChunk(
        bytes.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES)
      ),
    });
  }
  return frames;
}
