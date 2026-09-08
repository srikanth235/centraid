/*
 * The recovery-kit READER (#439): parses + validates the sealed document back
 * into a typed shape so `recover()` restores from nothing but this document.
 * Deliberately strict — reject wrong kind/version/keyring/addressing HERE,
 * not as an opaque provider error three phases later. By design (FORMAT.md)
 * the kit never carries the provider API key; the operator supplies it
 * out-of-band.
 */

import { createHash } from "node:crypto";

import { validateKeyring } from "./crypto.js";
import type { Keyring } from "./crypto.js";
import type { RecoveryKitTarget } from "./engine.js";
import { canonicalJson } from "./manifest.js";
import {
  unwrapPasswordDocument,
  wrapPasswordDocument,
} from "./password-wrap.js";
import type { WrappedPasswordDocument } from "./password-wrap.js";

/** A parsed + validated recovery kit (the shape `wrapRecoveryKit` seals). */
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
const KIT_LABEL = "recovery kit";
export { PASSWORD_WRAP_SCRYPT as RECOVERY_KIT_SCRYPT } from "./password-wrap.js";

export interface WrappedRecoveryKitDocument extends WrappedPasswordDocument {
  kind: typeof WRAPPED_KIT_KIND;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTarget(value: unknown, index: number): RecoveryKitTarget {
  if (!isRecord(value))
    throw new Error(`recovery kit: target ${index} is not an object`);
  // All four fields are load-bearing addressing for a restore; all required.
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
    ...(typeof value["identitySeed"] === "string"
      ? { identitySeed: value["identitySeed"] }
      : {}),
  };
}

/** Parse + validate an already-JSON-parsed kit; throws descriptively. */
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
        identitySeedHash: target.identitySeed
          ? createHash("sha256")
              .update(Buffer.from(target.identitySeed, "base64"))
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
  return {
    ...wrapPasswordDocument({
      label: KIT_LABEL,
      kind: WRAPPED_KIT_KIND,
      aad: WRAP_AAD,
      createdAt: plain.createdAt,
      fingerprint: recoveryKitFingerprint(plain),
      plain,
      passphrase,
    }),
    kind: WRAPPED_KIT_KIND,
  };
}

/**
 * Unwrap the owner-held password document; auth failures stay loud.
 *
 * NEVER add an unwrapped acceptance path (#568): it silently ignores the
 * password, and callers treating "parse succeeded" as "owner knows the
 * password" then get a password-free branch reachable from the kit file.
 */
export function parseRecoveryKit(
  value: unknown,
  passphrase: string
): RecoveryKitDocument {
  return unwrapPasswordDocument({
    label: KIT_LABEL,
    kind: WRAPPED_KIT_KIND,
    aad: WRAP_AAD,
    value,
    passphrase,
    parse: (plain) => parsePlainRecoveryKit(plain, true),
    fingerprintOf: recoveryKitFingerprint,
  });
}
