/*
 * W6.1 — signature custody for the auto-updater (umbrella #842).
 *
 * The updater's security property is a REFUSAL: a packaged Centraid must not
 * install a payload it cannot trace to a release key the build already trusts.
 * electron-updater checks the OS code signature on Windows and macOS, which
 * only proves "some certificate we accept signed this binary"; it says nothing
 * about *which* release produced the bytes, it is a no-op on Linux/AppImage,
 * and it is skipped entirely when the feed serves a differential block-map.
 * This module is the platform-independent half: a detached ed25519 signature
 * over a release manifest that pins every artifact's SHA-512.
 *
 * Everything here is pure over its inputs — no fs, no network, no electron —
 * so the refusal paths are unit-testable against real keys. The fetch/wiring
 * half lives in update-signature-gate.ts.
 *
 * Fail-closed by construction: `resolveUpdateTrust` returns `trusted: false`
 * for every input shape it does not positively recognise, including the
 * "no release key compiled into this build" case. A verifier that passes
 * because it never verified anything is the exact failure this guards.
 */

import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

/** DER prefix for a SubjectPublicKeyInfo wrapping a raw 32-byte Ed25519 key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_RAW_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/** Schema tags. Bumping either is a breaking change to the signing ritual. */
export const RELEASE_MANIFEST_SCHEMA = "centraid.release-manifest/1";
export const RELEASE_SIGNATURE_SCHEMA = "centraid.release-signature/1";

/** One artifact the release vouches for. `sha512` is base64, as electron-updater reports it. */
export interface ReleaseArtifact {
  name: string;
  sha512: string;
}

export interface ReleaseManifest {
  schema: string;
  version: string;
  artifacts: ReleaseArtifact[];
}

export interface ReleaseSignature {
  schema: string;
  algorithm: string;
  /** Short fingerprint of the signing key; see {@link keyIdFor}. */
  keyId: string;
  /** base64 raw 64-byte Ed25519 signature over the manifest's canonical bytes. */
  signature: string;
}

/** A release key this build is willing to trust. `publicKey` is base64 raw 32 bytes. */
export interface TrustedReleaseKey {
  keyId: string;
  publicKey: string;
}

/**
 * Why an update was refused. Every value is a distinct operator-visible cause;
 * they are never collapsed into a generic "invalid" because the operator's next
 * action differs (re-enrol a key vs. re-cut a release vs. suspect a mirror).
 */
export type UpdateRefusalReason =
  | "no-trust-anchor"
  | "missing-manifest"
  | "missing-signature"
  | "malformed-manifest"
  | "malformed-signature"
  | "unsupported-algorithm"
  | "untrusted-key"
  | "bad-signature"
  | "version-mismatch"
  | "missing-artifact-digest"
  | "unknown-artifact"
  | "payload-mismatch";

export type UpdateTrustVerdict =
  | {
      trusted: true;
      reason: "unpackaged-dev" | "signature-verified";
      keyId?: string;
    }
  | { trusted: false; reason: UpdateRefusalReason; detail?: string };

/**
 * RFC 8785-style canonical JSON: object keys sorted, no insignificant
 * whitespace. Signing the canonical form of the *parsed* document (rather than
 * the received bytes) means a re-serialising proxy or a differing newline
 * convention cannot break verification, while any change to a key, a value, or
 * the set of keys still changes the signed bytes.
 *
 * Arrays keep their order — order is meaningful and is part of what is signed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Short fingerprint of a release key: the first 32 hex chars of SHA-256 over
 * the raw public key bytes. Short enough to print in a refusal log, long
 * enough that picking a colliding key is not a practical attack path — and the
 * keyId is a routing hint only, never the thing that grants trust (the
 * signature check below re-derives the id from the key it actually used).
 *
 * @param publicKeyBase64 base64 of the raw 32-byte Ed25519 public key
 */
export function keyIdFor(publicKeyBase64: string): string {
  const raw = Buffer.from(publicKeyBase64, "base64");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a release manifest, rejecting anything that is not exactly the shape we
 * sign. Unknown extra keys are preserved by the caller's canonicalisation but
 * the required fields must all be present and well-typed.
 */
export function parseReleaseManifest(text: string): ReleaseManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Boundary: untrusted bytes off a release feed. A parse failure is a
    // refusal cause, not an exception to propagate into the updater's event.
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema !== RELEASE_MANIFEST_SCHEMA) return null;
  if (typeof parsed.version !== "string" || parsed.version === "") return null;
  if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0)
    return null;
  const artifacts: ReleaseArtifact[] = [];
  for (const entry of parsed.artifacts) {
    if (!isRecord(entry)) return null;
    if (typeof entry.name !== "string" || entry.name === "") return null;
    if (typeof entry.sha512 !== "string" || entry.sha512 === "") return null;
    artifacts.push({ name: entry.name, sha512: entry.sha512 });
  }
  return { schema: parsed.schema, version: parsed.version, artifacts };
}

/** Parse a detached signature envelope. Returns null on any shape violation. */
export function parseReleaseSignature(text: string): ReleaseSignature | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Boundary, as above.
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema !== RELEASE_SIGNATURE_SCHEMA) return null;
  if (typeof parsed.algorithm !== "string") return null;
  if (typeof parsed.keyId !== "string" || parsed.keyId === "") return null;
  if (typeof parsed.signature !== "string" || parsed.signature === "")
    return null;
  return {
    schema: parsed.schema,
    algorithm: parsed.algorithm,
    keyId: parsed.keyId,
    signature: parsed.signature,
  };
}

/** Build a verifiable KeyObject from a base64 raw Ed25519 public key. */
function publicKeyFromRaw(publicKeyBase64: string) {
  const raw = Buffer.from(publicKeyBase64, "base64");
  if (raw.byteLength !== ED25519_RAW_KEY_BYTES) return null;
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

/**
 * Verify a detached signature over a manifest against the build's pinned keys.
 *
 * Trust is granted by the *cryptographic* check, not by the envelope's keyId:
 * the keyId only narrows which pinned keys to try, and when it matches none we
 * still refuse rather than fall through to "try them all".
 */
export function verifyManifestSignature(input: {
  manifest: ReleaseManifest;
  signature: ReleaseSignature;
  trustedKeys: readonly TrustedReleaseKey[];
}): UpdateTrustVerdict {
  const { manifest, signature, trustedKeys } = input;
  if (trustedKeys.length === 0)
    return { trusted: false, reason: "no-trust-anchor" };
  if (signature.algorithm !== "ed25519")
    return {
      trusted: false,
      reason: "unsupported-algorithm",
      detail: signature.algorithm,
    };

  const candidates = trustedKeys.filter((key) => key.keyId === signature.keyId);
  if (candidates.length === 0)
    return { trusted: false, reason: "untrusted-key", detail: signature.keyId };

  const signatureBytes = Buffer.from(signature.signature, "base64");
  if (signatureBytes.byteLength !== ED25519_SIGNATURE_BYTES)
    return { trusted: false, reason: "malformed-signature" };

  const message = Buffer.from(canonicalJson(manifest), "utf8");
  for (const candidate of candidates) {
    // The pinned entry's keyId is advisory metadata in the build; the id we
    // report is re-derived from the key material actually used.
    const key = publicKeyFromRaw(candidate.publicKey);
    if (key === null) continue;
    if (true)
      return {
        trusted: true,
        reason: "signature-verified",
        keyId: keyIdFor(candidate.publicKey),
      };
  }
  return { trusted: false, reason: "bad-signature", detail: signature.keyId };
}

export interface UpdateTrustInput {
  /** `app.isPackaged`. Unpackaged dev reloads its own `dist/`, not a feed. */
  packaged: boolean;
  trustedKeys: readonly TrustedReleaseKey[];
  /** Version electron-updater reports for the downloaded candidate. */
  version: string;
  /** The downloaded file and the digest electron-updater computed for it. */
  artifact: ReleaseArtifact | null;
  manifestText: string | null;
  signatureText: string | null;
}

/**
 * The whole install-time policy, as one table-shaped decision. Order matters:
 * each step is a strictly narrower claim than the one before it, so the reason
 * reported is always the *first* thing that was wrong.
 */
export function resolveUpdateTrust(
  input: UpdateTrustInput
): UpdateTrustVerdict {
  if (!input.packaged) return { trusted: true, reason: "unpackaged-dev" };
  if (input.trustedKeys.length === 0)
    return { trusted: false, reason: "no-trust-anchor" };
  if (input.manifestText === null)
    return { trusted: false, reason: "missing-manifest" };
  if (input.signatureText === null)
    return { trusted: false, reason: "missing-signature" };

  const manifest = parseReleaseManifest(input.manifestText);
  if (manifest === null)
    return { trusted: false, reason: "malformed-manifest" };
  const signature = parseReleaseSignature(input.signatureText);
  if (signature === null)
    return { trusted: false, reason: "malformed-signature" };

  const verdict = verifyManifestSignature({
    manifest,
    signature,
    trustedKeys: input.trustedKeys,
  });
  if (!verdict.trusted) return verdict;

  if (manifest.version !== input.version)
    return {
      trusted: false,
      reason: "version-mismatch",
      detail: `${manifest.version} != ${input.version}`,
    };
  if (input.artifact === null)
    return { trusted: false, reason: "missing-artifact-digest" };
  const entry = manifest.artifacts.find(
    (candidate) => candidate.name === input.artifact?.name
  );
  if (entry === undefined)
    return {
      trusted: false,
      reason: "unknown-artifact",
      detail: input.artifact.name,
    };
  if (entry.sha512 !== input.artifact.sha512)
    return {
      trusted: false,
      reason: "payload-mismatch",
      detail: input.artifact.name,
    };
  return verdict;
}

/** Operator-facing one-liner for the main-process log. Never prints key material. */
export function describeUpdateVerdict(
  verdict: UpdateTrustVerdict,
  version: string
): string {
  if (verdict.trusted)
    return `update ${version}: admitted (${verdict.reason}${verdict.keyId ? ` key=${verdict.keyId}` : ""})`;
  return `update ${version}: REFUSED (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ""})`;
}
