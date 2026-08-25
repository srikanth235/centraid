/*
 * Shared iroh identity loader (#555).
 *
 * The persistence backend owns atomicity, wrapping, and permission repair.
 * This module owns the cross-consumer invariant: an endpoint secret is
 * exactly 32 bytes, and every caller chooses its corruption policy
 * explicitly.
 */

import { randomBytes } from "node:crypto";

export type EndpointSecretCorruptionPolicy = "refuse" | "remint";

export interface EndpointSecretPersistence {
  load: () => Uint8Array | null;
  store: (secret: Uint8Array) => void;
}

export interface LoadEndpointSecretOptions {
  persistence: EndpointSecretPersistence;
  onCorrupt: EndpointSecretCorruptionPolicy;
  label: string;
  warn?: (message: string) => void;
}

export class EndpointSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EndpointSecretError";
  }
}

export function loadEndpointSecret(
  options: LoadEndpointSecretOptions
): Uint8Array {
  let existing: Uint8Array | null;
  try {
    existing = options.persistence.load();
  } catch (error) {
    return handleCorrupt(
      options,
      error instanceof Error ? error.message : String(error)
    );
  }
  if (existing === null) return mint(options.persistence);
  if (existing.byteLength !== 32) {
    return handleCorrupt(
      options,
      `${options.label} is ${existing.byteLength} bytes; an iroh identity must be 32 bytes`
    );
  }
  return Uint8Array.from(existing);
}

function handleCorrupt(
  options: LoadEndpointSecretOptions,
  detail: string
): Uint8Array {
  if (options.onCorrupt === "remint") {
    options.warn?.(
      `${detail}; minted a new device identity and re-pairing is required`
    );
    return mint(options.persistence);
  }
  throw new EndpointSecretError(
    `${detail}. Restore the original ${options.label} from host credentials, or remove it deliberately and re-pair every enrolled device.`
  );
}

function mint(persistence: EndpointSecretPersistence): Uint8Array {
  const secret = Uint8Array.from(randomBytes(32));
  persistence.store(secret);
  return secret;
}
