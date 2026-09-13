/*
 * The browser's native-messaging framing, as bytes (#1020, D-1020-F6).
 *
 * `chrome.runtime.connectNative` does the framing itself, so the extension never
 * needs this — but the round-trip script does, and so does anyone debugging a
 * host that the browser silently disconnects. The length is **native-endian**,
 * which is where the product's own `u32BE` framing would be wrong
 * (`crates/centraid/src/cmd/native_host.rs`: three framings live in that binary
 * and confusing two of them is the whole bug class).
 *
 * ## What used to be here
 *
 * Lane F put the retry classification and the member sentences in this file. They
 * moved to `host-link.ts` in wave 4 (#1020 lane extension), where the port lives:
 * the retry rule is about what may be repeated, and the host now answers that per
 * frame, so the classification belongs beside the thing that reads the answer.
 * Two copies of a rule about repeating a write is the failure this move avoids.
 */

/** The host's name, matching `centraid native-host install`'s manifest. */
export { HOST_NAME } from "./host-link.js";

/**
 * Frame a message the way the browser does.
 *
 * `littleEndian` is the HOST platform's byte order, not a choice: Chrome writes
 * and reads `u32` in native order, so a caller passes what `os.endianness()`
 * said.
 */
export function frameNativeMessage(
  message: unknown,
  littleEndian: boolean
): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const framed = new Uint8Array(4 + body.length);
  new DataView(framed.buffer).setUint32(0, body.length, littleEndian);
  framed.set(body, 4);
  return framed;
}

/** The inverse. Returns `undefined` when the frame is not whole yet. */
export function readNativeMessage(
  bytes: Uint8Array,
  littleEndian: boolean
): { message: unknown; consumed: number } | undefined {
  if (bytes.length < 4) return undefined;
  const length = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getUint32(0, littleEndian);
  if (bytes.length < 4 + length) return undefined;
  const body = new TextDecoder().decode(bytes.subarray(4, 4 + length));
  return { message: JSON.parse(body) as unknown, consumed: 4 + length };
}
