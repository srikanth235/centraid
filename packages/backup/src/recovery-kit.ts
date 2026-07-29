/*
 * The recovery-kit READER (issue #439 R1) — the counterpart to
 * `writeRecoveryKit` (engine.ts). `writeRecoveryKit` emits
 * `{version, kind, createdAt, keyring, targets}` (FORMAT.md § Recovery kit);
 * this parses + validates that document back into a typed shape so `recover()`
 * can restore "from nothing but this document". It is deliberately strict:
 * the kit is the ONLY thing standing between a blank machine and a vault, so a
 * wrong `kind`, an unsupported `version`, a malformed keyring, or a target
 * missing its addressing is rejected here rather than surfacing as an opaque
 * provider error three phases later.
 *
 * What the kit does NOT carry, by design (FORMAT.md): the provider API key. The
 * `target.provider` field is the provider's base URL (for a remote home) or a
 * `local:<dir>` moniker (an operator/test local provider) — enough to reach the
 * provider, but never the credential to authenticate. The recovering operator
 * supplies the key out-of-band (the invite email at beta; the provisioning
 * handshake at GA).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

import { validateKeyring } from "./crypto.js";
import type { Keyring } from "./crypto.js";
import type { RecoveryKitTarget } from "./engine.js";
import { canonicalJson } from "./manifest.js";

/** A parsed + validated recovery kit (the shape `writeRecoveryKit` emits). */
export interface RecoveryKitDocument {
  version: 1;
  kind: "centraid-recovery-kit";
  /** ISO-8601 stamp the kit was written at (advisory). */
  createdAt: string;
  /** Every key epoch — the master material every snapshot was sealed under. */
  keyring: Keyring;
  /** One row per vault this gateway backs up: how to reach + address it. */
  targets: RecoveryKitTarget[];
}

const KIT_KIND = "centraid-recovery-kit";
const WRAPPED_KIT_KIND = "centraid-recovery-kit-wrapped";
const WRAP_AAD = Buffer.from("centraid-recovery-kit-wrap-v1", "utf8");
export const RECOVERY_KIT_SCRYPT = {
  kdf: "scrypt" as const,
  N: 2 ** 17,
  r: 8,
  p: 1,
};

export interface WrappedRecoveryKitDocument {
  version: 1;
  kind: typeof WRAPPED_KIT_KIND;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTarget(value: unknown, index: number): RecoveryKitTarget {
  if (!isRecord(value))
    throw new Error(`recovery kit: target ${index} is not an object`);
  // `provider` is the base URL (remote) or `local:<dir>` moniker — the
  // addressing recover() dials; `targetId` + `vaultId` are the storage-target
  // and vault ids; `label` is the opaque provider-side label (never the vault
  // name). All four are load-bearing for a restore, so all four are required.
  for (const field of ["provider", "targetId", "vaultId", "label"] as const) {
    if (
      typeof value[field] !== "string" ||
      (value[field] as string).length === 0
    ) {
      throw new Error(`recovery kit: target ${index} is missing "${field}"`);
    }
  }
  return {
    provider: value["provider"] as string,
    targetId: value["targetId"] as string,
    vaultId: value["vaultId"] as string,
    label: value["label"] as string,
    ...(typeof value["sealKey"] === "string"
      ? { sealKey: value["sealKey"] }
      : {}),
  };
}

/**
 * Parse + validate a recovery-kit document (already JSON-parsed into `value`).
 * Throws a descriptive `Error` on anything that is not a well-formed
 * `centraid-recovery-kit` version 1: wrong kind, unsupported version, a
 * malformed keyring (via the same `validateKeyring` `loadKeyring` uses), or a
 * target missing its addressing. Returns the typed document on success.
 */
function parsePlainRecoveryKit(
  value: unknown,
  allowEmptyTargets = false
): RecoveryKitDocument {
  if (!isRecord(value)) throw new Error("recovery kit: not an object");
  if (value["kind"] !== KIT_KIND) {
    throw new Error(
      `recovery kit: not a ${KIT_KIND} (kind=${JSON.stringify(value["kind"])}) — ` +
        "this is not a centraid recovery kit"
    );
  }
  if (value["version"] !== 1) {
    throw new Error(
      `recovery kit: unsupported version ${JSON.stringify(value["version"])} — update the gateway`
    );
  }
  const keyring = validateKeyring(value["keyring"]);
  if (
    !Array.isArray(value["targets"]) ||
    (!allowEmptyTargets && value["targets"].length === 0)
  ) {
    throw new Error(
      `recovery kit: "targets" must be ${allowEmptyTargets ? "an array" : "a non-empty array"}`
    );
  }
  const targets = (value["targets"] as unknown[]).map((t, i) =>
    validateTarget(t, i)
  );
  const createdAt =
    typeof value["createdAt"] === "string" ? value["createdAt"] : "";
  return { version: 1, kind: KIT_KIND, createdAt, keyring, targets };
}

function isWrappedKit(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value["kind"] === WRAPPED_KIT_KIND;
}

function deriveWrapKey(
  passphrase: string,
  salt: Buffer,
  params: Pick<WrappedRecoveryKitDocument, "N" | "r" | "p">
): Buffer {
  if (passphrase.length === 0)
    throw new Error("recovery kit: password is required");
  return scryptSync(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 256 * 1024 * 1024,
  });
}

/**
 * Stable capability fingerprint. Labels and createdAt are deliberately
 * excluded: cosmetic changes do not alter recovery ability.
 */
export function recoveryKitFingerprint(document: RecoveryKitDocument): string {
  const preimage = {
    version: document.version,
    keyring: [...document.keyring.epochs]
      .sort((a, b) => a.epoch - b.epoch)
      .map((epoch) => ({
        epoch: epoch.epoch,
        keyHash: createHash("sha256")
          .update(Buffer.from(epoch.key, "base64"))
          .digest("hex"),
      })),
    targets: [...document.targets]
      .sort(
        (a, b) =>
          a.vaultId.localeCompare(b.vaultId) ||
          a.targetId.localeCompare(b.targetId)
      )
      .map((target) => ({
        provider: target.provider,
        targetId: target.targetId,
        vaultId: target.vaultId,
        sealkeyHash: target.sealKey
          ? createHash("sha256")
              .update(Buffer.from(target.sealKey, "base64"))
              .digest("hex")
          : null,
      })),
  };
  return createHash("sha256").update(canonicalJson(preimage)).digest("hex");
}

/** Server-side password wrap; provider credentials never enter the document. */
export function wrapRecoveryKit(
  document: RecoveryKitDocument,
  passphrase: string
): WrappedRecoveryKitDocument {
  const plain = parsePlainRecoveryKit(document, true);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = deriveWrapKey(passphrase, salt, RECOVERY_KIT_SCRYPT);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(WRAP_AAD);
  const ciphertext = Buffer.concat([
    cipher.update(canonicalJson(plain), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    kind: WRAPPED_KIT_KIND,
    createdAt: plain.createdAt,
    fingerprint: recoveryKitFingerprint(plain),
    ...RECOVERY_KIT_SCRYPT,
    salt: salt.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Unwrap the owner-held password document. Authentication failures stay loud.
 *
 * There is no unwrapped acceptance path (issue #568 item J). Accepting a plain
 * document also SILENTLY IGNORED the supplied password, so every caller that
 * treats "parse succeeded" as "the owner knows the password" —
 * `vaults:restore`, `vaults:initialize/verify`, and the kit-confirmed
 * transition — had a password-free branch. v0 carries no back-compat
 * obligation, so the branch is gone rather than gated.
 */
export function parseRecoveryKit(
  value: unknown,
  passphrase: string
): RecoveryKitDocument {
  if (!isWrappedKit(value)) {
    throw new Error(
      "recovery kit: expected a password-wrapped kit " +
        `("${WRAPPED_KIT_KIND}"); unwrapped kits are not accepted`
    );
  }
  for (const field of ["N", "r", "p"] as const) {
    if (
      typeof value[field] !== "number" ||
      !Number.isSafeInteger(value[field])
    ) {
      throw new Error(`recovery kit: wrapped header has invalid "${field}"`);
    }
  }
  if (value["kdf"] !== "scrypt")
    throw new Error("recovery kit: unsupported KDF");
  for (const field of ["salt", "nonce", "tag", "ciphertext"] as const) {
    if (typeof value[field] !== "string") {
      throw new Error(`recovery kit: wrapped header is missing "${field}"`);
    }
  }
  if (passphrase.length === 0)
    throw new Error("recovery kit: password is required");
  try {
    const salt = Buffer.from(value["salt"] as string, "base64");
    const key = deriveWrapKey(passphrase, salt, {
      N: value["N"] as number,
      r: value["r"] as number,
      p: value["p"] as number,
    });
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(value["nonce"] as string, "base64")
    );
    decipher.setAAD(WRAP_AAD);
    decipher.setAuthTag(Buffer.from(value["tag"] as string, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(value["ciphertext"] as string, "base64")),
      decipher.final(),
    ]);
    const parsed = parsePlainRecoveryKit(
      JSON.parse(plain.toString("utf8")),
      true
    );
    if (
      typeof value["fingerprint"] !== "string" ||
      recoveryKitFingerprint(parsed) !== value["fingerprint"]
    ) {
      throw new Error("fingerprint mismatch");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `recovery kit: wrong password or corrupt file (${error instanceof Error ? error.message : String(error)})`,
      { cause: error }
    );
  }
}
