import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

import { canonicalJson } from "./manifest.js";

export interface WrappedPasswordDocument {
  version: 1;
  kind: string;
  createdAt: string;
  fingerprint: string;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export const PASSWORD_WRAP_SCRYPT = {
  kdf: "scrypt" as const,
  N: 2 ** 17,
  r: 8,
  p: 1,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deriveWrapKey(
  label: string,
  passphrase: string,
  salt: Buffer,
  params: Pick<WrappedPasswordDocument, "N" | "r" | "p">
): Buffer {
  if (passphrase.length === 0)
    throw new Error(`${label}: password is required`);
  return scryptSync(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

export function wrapPasswordDocument(opts: {
  label: string;
  kind: string;
  aad: Buffer;
  createdAt: string;
  fingerprint: string;
  plain: unknown;
  passphrase: string;
}): WrappedPasswordDocument {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveWrapKey(
    opts.label,
    opts.passphrase,
    salt,
    PASSWORD_WRAP_SCRYPT
  );
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(opts.aad);
  const ciphertext = Buffer.concat([
    cipher.update(canonicalJson(opts.plain), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    kind: opts.kind,
    createdAt: opts.createdAt,
    fingerprint: opts.fingerprint,
    ...PASSWORD_WRAP_SCRYPT,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function unwrapPasswordDocument<T>(opts: {
  label: string;
  kind: string;
  aad: Buffer;
  value: unknown;
  passphrase: string;
  parse: (plain: unknown) => T;
  fingerprintOf: (parsed: T) => string;
}): T {
  const value = opts.value;
  if (!isRecord(value) || value["kind"] !== opts.kind) {
    throw new Error(
      `${opts.label}: expected a password-wrapped kit ` +
        `("${opts.kind}"); unwrapped kits are not accepted`
    );
  }
  for (const field of ["N", "r", "p"] as const) {
    if (
      typeof value[field] !== "number" ||
      !Number.isSafeInteger(value[field])
    ) {
      throw new Error(`${opts.label}: wrapped header has invalid "${field}"`);
    }
  }
  if (value["kdf"] !== "scrypt")
    throw new Error(`${opts.label}: unsupported KDF`);
  for (const field of ["salt", "nonce", "tag", "ciphertext"] as const) {
    if (typeof value[field] !== "string") {
      throw new Error(`${opts.label}: wrapped header is missing "${field}"`);
    }
  }
  if (opts.passphrase.length === 0)
    throw new Error(`${opts.label}: password is required`);
  try {
    const salt = Buffer.from(value["salt"] as string, "base64");
    const key = deriveWrapKey(opts.label, opts.passphrase, salt, {
      N: value["N"] as number,
      r: value["r"] as number,
      p: value["p"] as number,
    });
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(value["nonce"] as string, "base64")
    );
    decipher.setAAD(opts.aad);
    decipher.setAuthTag(Buffer.from(value["tag"] as string, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(value["ciphertext"] as string, "base64")),
      decipher.final(),
    ]);
    const parsed = opts.parse(JSON.parse(plain.toString("utf8")));
    if (
      typeof value["fingerprint"] !== "string" ||
      opts.fingerprintOf(parsed) !== value["fingerprint"]
    ) {
      throw new Error("fingerprint mismatch");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${opts.label}: wrong password or corrupt file (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}
