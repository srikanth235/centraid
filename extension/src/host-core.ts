/*
 * The Companion's pure layer: retry classification, and the host port's own
 * failure vocabulary (#1020, D-1020-F6).
 *
 * ## What changed from v0, and what did not
 *
 * v0's extension talks to the gateway over **WASM iroh in the service worker**
 * (`apps/extension/src/transport.ts:4`–`:9`, and `'wasm-unsafe-eval'` in its
 * CSP). That is gone: this Companion talks to the Centraid app on this machine
 * over **native messaging**, so the manifest has `nativeMessaging` and no
 * `host_permissions` at all — there is no host for it to reach.
 *
 * What IS carried, verbatim in substance, is the retry classification
 * (`transport-core.ts:33`–`:52`): **a revoked device is never retried**, and a
 * non-idempotent method only retries a clear connect failure. Both rules are
 * about not repeating a write the other end may have taken, which a different
 * transport does not change. The 401 sentence is carried too
 * (`transport-core.ts:55`–`:60`) and re-pointed: there is no HTTP status on a
 * native port, so the same member sentence now answers the host's
 * `no-capability` refusal.
 */

/** The host's name, matching `centraid native-host install`'s manifest. */
export const HOST_NAME = "dev.centraid.host";

/** A disconnect: `chrome.runtime.lastError.message` contains this. */
export const CONNECT_FAILURE_MARKER =
  "Specified native messaging host not found";

/** The app said this browser's grant is gone. */
export const REVOKED_MARKER = "no-capability";

/**
 * The member sentence for a port that cannot be used.
 *
 * One sentence per reason and no raw error text: a member cannot act on
 * "ECONNREFUSED", and the host's own refusal codes each map to something they
 * can do. Ported in spirit from v0's `companionHttpError`, where 401 was the
 * only case that earned its own words.
 */
export function memberSentence(code: string): string {
  switch (code) {
    case "no-capability":
    case "token-unknown":
    case "token-spent":
      return "Open Centraid and allow the browser extension to connect.";
    case "host-missing":
      return "Centraid is not installed on this computer, or its browser connector has not been set up yet.";
    case "foreign-peer":
      return "Centraid is running as a different user account on this computer.";
    case "protocol-mismatch":
      return "Centraid and this extension are from different versions — update both.";
    default:
      return "Centraid could not answer that. Open the app and try again.";
  }
}

/** Every code `memberSentence` answers, so the drift test has one list. */
export const KNOWN_CODES = [
  "no-capability",
  "token-unknown",
  "token-spent",
  "host-missing",
  "foreign-peer",
  "protocol-mismatch",
] as const;

export function isConnectFailure(
  error: unknown,
  marker = CONNECT_FAILURE_MARKER
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(marker);
}

export function isDeviceRevoked(
  error: unknown,
  marker = REVOKED_MARKER
): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(marker);
}

/**
 * Whether a failed request should be retried.
 *
 * v0's rule, carried: a revoked device is never retried, and a request that is
 * not idempotent only retries a **clear connect failure** — because a request
 * that reached the other end and then failed may have been taken.
 */
export function shouldRetry(input: {
  attempt: number;
  maxAttempts: number;
  /** The Companion's own verb, e.g. `read` or `capture`. */
  method: string;
  error: unknown;
  idempotentMethods?: ReadonlySet<string>;
}): boolean {
  if (isDeviceRevoked(input.error)) return false;
  if (input.attempt >= input.maxAttempts) return false;
  const idempotent =
    input.idempotentMethods ?? new Set(["read", "stat", "list", "ping"]);
  if (idempotent.has(input.method.toLowerCase())) return true;
  return isConnectFailure(input.error);
}

/**
 * The browser's native-messaging framing, as bytes.
 *
 * `chrome.runtime.connectNative` does the framing itself, so the extension
 * never needs this — but the round-trip script does, and so does anyone
 * debugging a host that the browser silently disconnects. The length is
 * **native-endian**, which is where the product's own `u32BE` framing would be
 * wrong (`crates/centraid/src/cmd/native_host.rs`).
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
