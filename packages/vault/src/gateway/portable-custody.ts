/*
 * The portable export's CUSTODY KIT (#630, closing the 10.1 finding).
 *
 * A portable bundle carries sealed cells as ciphertext and NOTHING that opens
 * them. The vault's data-encryption key leaves only here: password-wrapped
 * with the same scrypt→AES-256-GCM machinery the backup recovery kit uses
 * (`@centraid/backup`'s `wrapPasswordDocument`), so there is one wrap, one KDF
 * cost, and one "no unwrapped acceptance path" rule (#568) rather than two.
 *
 * The kit rides INSIDE the bundle at `custody/recovery-kit.json`. That is safe
 * precisely because it is wrapped: the zip is then password-protected exactly
 * where it matters and readable everywhere else. Without a passphrase the
 * export simply has no kit, and its manifest says `sealed: "ciphertext-only"`.
 */

import { createHash } from "node:crypto";

import { unwrapPasswordDocument, wrapPasswordDocument } from "@centraid/backup";
import type { WrappedPasswordDocument } from "@centraid/backup";

import { sealKeyFingerprint } from "../schema/sealed.js";
import { canonicalJson } from "./portability.js";

/** Where the wrapped kit lives inside the bundle. */
export const PORTABLE_CUSTODY_KIT_PATH = "custody/recovery-kit.json";

const KIT_KIND = "centraid-portable-custody-kit";
const WRAPPED_KIT_KIND = "centraid-portable-custody-kit-wrapped";
const WRAP_AAD = Buffer.from("centraid-portable-custody-wrap-v1", "utf8");
const KIT_LABEL = "portable export custody kit";
const KEY_BYTES = 32;

/** The plaintext document — it exists only between the wrap and the unwrap. */
export interface PortableCustodyKit {
  version: 1;
  kind: typeof KIT_KIND;
  createdAt: string;
  /** The vault the key belongs to, so a mismatched kit is caught by a human. */
  vaultId: string;
  /** Non-secret identity of the key below; also re-derived on unwrap. */
  sealKeyFingerprint: string;
  /** base64 of the 32-byte DEK. */
  sealKey: string;
}

export interface WrappedPortableCustodyKit extends WrappedPasswordDocument {
  kind: typeof WRAPPED_KIT_KIND;
}

function parsePlainKit(value: unknown): PortableCustodyKit {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${KIT_LABEL}: not an object`);
  const kit = value as Record<string, unknown>;
  if (kit["kind"] !== KIT_KIND)
    throw new Error(
      `${KIT_LABEL}: not a ${KIT_KIND} (kind=${JSON.stringify(kit["kind"])})`
    );
  if (kit["version"] !== 1)
    throw new Error(
      `${KIT_LABEL}: unsupported version ${JSON.stringify(kit["version"])}`
    );
  for (const field of ["vaultId", "sealKey", "sealKeyFingerprint"] as const) {
    if (typeof kit[field] !== "string" || (kit[field] as string).length === 0)
      throw new Error(`${KIT_LABEL}: missing "${field}"`);
  }
  const key = Buffer.from(kit["sealKey"] as string, "base64");
  if (key.length !== KEY_BYTES)
    throw new Error(`${KIT_LABEL}: seal key must be base64 of 32 bytes`);
  if (sealKeyFingerprint(key) !== kit["sealKeyFingerprint"])
    throw new Error(`${KIT_LABEL}: seal key does not match its fingerprint`);
  return {
    version: 1,
    kind: KIT_KIND,
    createdAt: typeof kit["createdAt"] === "string" ? kit["createdAt"] : "",
    vaultId: kit["vaultId"] as string,
    sealKeyFingerprint: kit["sealKeyFingerprint"] as string,
    sealKey: kit["sealKey"] as string,
  };
}

/** Capability fingerprint: which vault, which key — never the key itself. */
function kitFingerprint(kit: PortableCustodyKit): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        version: kit.version,
        vaultId: kit.vaultId,
        sealKeyFingerprint: kit.sealKeyFingerprint,
      })
    )
    .digest("hex");
}

/** Wrap one vault's DEK for the bundle. The plaintext never reaches disk. */
export function wrapPortableCustodyKit(
  input: { vaultId: string; sealKey: Buffer; createdAt: string },
  passphrase: string
): WrappedPortableCustodyKit {
  if (input.sealKey.length !== KEY_BYTES)
    throw new Error(`${KIT_LABEL}: seal key must be 32 bytes`);
  const plain = parsePlainKit({
    version: 1,
    kind: KIT_KIND,
    createdAt: input.createdAt,
    vaultId: input.vaultId,
    sealKeyFingerprint: sealKeyFingerprint(input.sealKey),
    sealKey: input.sealKey.toString("base64"),
  });
  return {
    ...wrapPasswordDocument({
      label: KIT_LABEL,
      kind: WRAPPED_KIT_KIND,
      aad: WRAP_AAD,
      createdAt: plain.createdAt,
      fingerprint: kitFingerprint(plain),
      plain,
      passphrase,
    }),
    kind: WRAPPED_KIT_KIND,
  };
}

/** Open a wrapped kit. A wrong password stays a loud, distinguishable error. */
export function parsePortableCustodyKit(
  value: unknown,
  passphrase: string
): PortableCustodyKit {
  return unwrapPasswordDocument({
    label: KIT_LABEL,
    kind: WRAPPED_KIT_KIND,
    aad: WRAP_AAD,
    value,
    passphrase,
    parse: parsePlainKit,
    fingerprintOf: kitFingerprint,
  });
}

/** The DEK a parsed kit carries, as bytes. */
export function custodyKitSealKey(kit: PortableCustodyKit): Buffer {
  return Buffer.from(kit.sealKey, "base64");
}
