import { createHash } from "node:crypto";

import { unwrapPasswordDocument, wrapPasswordDocument } from "@centraid/backup";
import type { WrappedPasswordDocument } from "@centraid/backup";

import { sealKeyFingerprint } from "../schema/sealed.js";
import { canonicalJson } from "./portability.js";

export const PORTABLE_CUSTODY_KIT_PATH = "custody/recovery-kit.json";

const KIT_KIND = "centraid-portable-custody-kit";
const WRAPPED_KIT_KIND = "centraid-portable-custody-kit-wrapped";
const WRAP_AAD = Buffer.from("centraid-portable-custody-wrap-v1", "utf8");
const KIT_LABEL = "portable export custody kit";
const KEY_BYTES = 32;

export interface PortableCustodyKit {
  version: 1;
  kind: typeof KIT_KIND;
  createdAt: string;
  vaultId: string;
  sealKeyFingerprint: string;
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

export function custodyKitSealKey(kit: PortableCustodyKit): Buffer {
  return Buffer.from(kit.sealKey, "base64");
}
