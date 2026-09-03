/*
 * Updater signature custody, pure half (#842); fetching lives in
 * update-signature-gate.ts. Trust rests on a detached ed25519 signature over a
 * manifest pinning each artifact's SHA-512, never on OS code-signing (a no-op
 * on AppImage, skipped for block-maps). Keep this module pure and fail-closed:
 * an unrecognised shape is `trusted: false`.
 */
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_RAW_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

export const RELEASE_MANIFEST_SCHEMA = "centraid.release-manifest/1";
export const RELEASE_SIGNATURE_SCHEMA = "centraid.release-signature/1";

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
  keyId: string;
  signature: string;
}

export interface TrustedReleaseKey {
  keyId: string;
  publicKey: string;
}

/** Never collapse into a generic "invalid": the operator's next action differs. */
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
 * Sign the parsed document's canonical form, never the received bytes, so a
 * re-serialising proxy cannot break verification. Array order is signed.
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

/** A keyId is a routing hint, never the thing that grants trust. */
export function keyIdFor(publicKeyBase64: string): string {
  const raw = Buffer.from(publicKeyBase64, "base64");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleaseManifest(text: string): ReleaseManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schema !== RELEASE_MANIFEST_SCHEMA) return null;
  if (typeof parsed.version !== "string" || parsed.version === "") return null;
  if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length === 0)
    // Untrusted feed bytes: malformed is a refusal cause, never a throw.
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

export function parseReleaseSignature(text: string): ReleaseSignature | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
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

function publicKeyFromRaw(publicKeyBase64: string) {
  const raw = Buffer.from(publicKeyBase64, "base64");
  if (raw.byteLength !== ED25519_RAW_KEY_BYTES) return null;
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

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
    const key = publicKeyFromRaw(candidate.publicKey);
    if (key === null) continue;
    if (verifySignature(null, message, key, signatureBytes))
      return {
        trusted: true,
        reason: "signature-verified",
        keyId: keyIdFor(candidate.publicKey),
      };
  }
  return { trusted: false, reason: "bad-signature", detail: signature.keyId };
}

export interface UpdateTrustInput {
  packaged: boolean;
  trustedKeys: readonly TrustedReleaseKey[];
  version: string;
  artifact: ReleaseArtifact | null;
  manifestText: string | null;
  signatureText: string | null;
}

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

/** Never prints key material. */
export function describeUpdateVerdict(
  verdict: UpdateTrustVerdict,
  version: string
): string {
  if (verdict.trusted)
    return `update ${version}: admitted (${verdict.reason}${verdict.keyId ? ` key=${verdict.keyId}` : ""})`;
  return `update ${version}: REFUSED (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ""})`;
}
