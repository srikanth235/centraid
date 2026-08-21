/**
 * W6.2 — bill of materials, provenance, and release signing (umbrella #842).
 *
 * Pure functions over explicit inputs: no clock, no network, no argv. The CLI
 * that wires them to the filesystem is `supply-chain.mjs`; the tests drive this
 * module directly with real Ed25519 keys.
 *
 * Determinism is a hard requirement, not a nicety — a BOM or a provenance
 * statement that differs between two builds of the same commit cannot be
 * compared, and an attestation nobody can reproduce attests to nothing. Every
 * timestamp is an INPUT (the caller passes the commit time or SOURCE_DATE_EPOCH)
 * and the document serial number is derived from the content digest.
 */

import {
  createHash,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

/** DER prefix for a SubjectPublicKeyInfo wrapping a raw 32-byte Ed25519 key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export const RELEASE_MANIFEST_SCHEMA = "centraid.release-manifest/1";
export const RELEASE_SIGNATURE_SCHEMA = "centraid.release-signature/1";
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

/**
 * Documents the release tooling itself writes into the artifact directory.
 * They are excluded from every digest set: a manifest that listed itself would
 * be unverifiable (writing it changes its own digest), and a re-run over a
 * directory that already holds them would otherwise attest to a different,
 * self-referential set each time.
 */
export const RELEASE_METADATA_FILES = new Set([
  "centraid-release-manifest.json",
  "centraid-release-manifest.sig.json",
  "sbom.cdx.json",
  "provenance.intoto.json",
]);
export const SLSA_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";

/**
 * RFC 8785-style canonical JSON. Byte-identical to `canonicalJson` in
 * `apps/desktop/src/main/update-signature-core.ts`; the cross-language
 * agreement is asserted by a test that signs here and verifies there.
 *
 * @param {unknown} value any JSON-representable document
 * @returns {string} the canonical serialisation that gets signed
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "null";
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const parts = Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * SHA-256 of some bytes.
 * @param {Buffer|string} data bytes to digest
 * @returns {string} lowercase hex digest
 */
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * SHA-512 of some bytes, in the encoding electron-updater's feed uses.
 * @param {Buffer} data bytes to digest
 * @returns {string} base64 digest
 */
export function sha512Base64(data) {
  return createHash("sha512").update(data).digest("base64");
}

/**
 * Read the dependency inventory out of `bun.lock`.
 *
 * Deliberately line-oriented rather than a JSONC parse: bun.lock is not valid
 * JSON (trailing commas), the entry grammar is stable, and a hand-rolled parser
 * with no dependency is the right trade for a file that gates the release. Each
 * entry is `"key": ["name@version", registry, meta, integrity]`.
 *
 * @param {string} text contents of bun.lock
 * @returns {{ packages: Array<{name:string,version:string,integrity:string|null,workspace:boolean}>, errors: string[] }} the inventory, plus any lines the parser could not read
 */
export function parseBunLock(text) {
  const errors = [];
  const packages = [];
  const seen = new Set();
  const entry = /^ {4}"(?<key>(?:[^"\\]|\\.)+)": \[(?<body>.*)\],?$/gmu;
  for (const match of text.matchAll(entry)) {
    const body = match.groups.body;
    const descriptor = /^"(?<spec>(?:[^"\\]|\\.)*)"/u.exec(body);
    if (descriptor === null) {
      errors.push(`unparseable lockfile entry: ${match.groups.key}`);
      continue;
    }
    const spec = descriptor.groups.spec;
    const at = spec.lastIndexOf("@");
    if (at <= 0) {
      errors.push(`lockfile entry has no version: ${spec}`);
      continue;
    }
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const workspace = version.startsWith("workspace:");
    const integrityMatch = /"(?<hash>sha(?:512|256)-[A-Za-z0-9+/=]+)"/u.exec(
      body
    );
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({
      name,
      version,
      integrity: integrityMatch === null ? null : integrityMatch.groups.hash,
      workspace,
    });
  }
  if (packages.length === 0)
    errors.push(
      "bun.lock yielded no packages — parser or lockfile changed shape"
    );
  packages.sort((a, b) =>
    a.name === b.name
      ? a.version.localeCompare(b.version)
      : a.name.localeCompare(b.name)
  );
  return { packages, errors };
}

/** Package URL for an npm component, per the purl spec's npm type. */
export function purlFor(name, version) {
  const encoded = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`;
}

/**
 * Build a CycloneDX 1.6 BOM over a parsed lockfile inventory.
 *
 * @param {{ packages: Array<{name:string,version:string,integrity:string|null,workspace:boolean}>,
 *           component: { name: string, version: string },
 *           timestamp: string }} input inventory, the root component, and an ISO-8601 timestamp supplied by the caller
 * @returns {Record<string, unknown>} a CycloneDX 1.6 BOM document
 */
export function buildSbom(input) {
  const components = input.packages.map((pkg) => {
    const component = {
      type: pkg.workspace ? "application" : "library",
      "bom-ref": purlFor(pkg.name, pkg.version),
      name: pkg.name,
      version: pkg.version,
      purl: purlFor(pkg.name, pkg.version),
      scope: "required",
    };
    if (pkg.integrity !== null) {
      const [algorithm, value] = pkg.integrity.split("-");
      component.hashes = [
        {
          alg: algorithm === "sha512" ? "SHA-512" : "SHA-256",
          content: Buffer.from(value, "base64").toString("hex"),
        },
      ];
    }
    return component;
  });
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: input.timestamp,
      component: {
        type: "application",
        "bom-ref": purlFor(input.component.name, input.component.version),
        name: input.component.name,
        version: input.component.version,
      },
      tools: {
        components: [
          { type: "application", name: "centraid-supply-chain", version: "1" },
        ],
      },
    },
    components,
  };
  // Serial number is a digest of the content, so the same commit always
  // produces the same document (a random UUID would defeat reproducibility).
  const digest = sha256Hex(canonicalJson(bom));
  bom.serialNumber = `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return bom;
}

/**
 * Check that a BOM still describes the lockfile it claims to. This is the half
 * that has teeth: a BOM generated once and never re-checked drifts into fiction
 * the first time a dependency is added.
 *
 * @param {Record<string, unknown>} bom the BOM to check
 * @param {Array<{name:string,version:string}>} packages the lockfile inventory it must describe
 * @returns {{ ok: boolean, missing: string[], extra: string[], errors: string[] }} the verdict and the drift in both directions
 */
export function verifySbom(bom, packages) {
  const errors = [];
  if (bom?.bomFormat !== "CycloneDX") errors.push("not a CycloneDX document");
  if (typeof bom?.specVersion !== "string") errors.push("no specVersion");
  if (typeof bom?.serialNumber !== "string") errors.push("no serialNumber");
  const listed = new Set(
    (bom?.components ?? []).map((c) => `${c.name}@${c.version}`)
  );
  const expected = new Set(packages.map((p) => `${p.name}@${p.version}`));
  const missing = [...expected].filter((id) => !listed.has(id)).sort();
  const extra = [...listed].filter((id) => !expected.has(id)).sort();
  if (missing.length > 0)
    errors.push(`${missing.length} lockfile package(s) absent from the BOM`);
  if (extra.length > 0)
    errors.push(`${extra.length} BOM component(s) not in the lockfile`);
  return { ok: errors.length === 0, missing, extra, errors };
}

/**
 * Build an in-toto v1 statement carrying SLSA v1 provenance over release
 * artifacts. Subjects carry real digests computed by the caller from real bytes.
 *
 * @param {{ subjects: Array<{name:string,sha256:string}>,
 *           builderId: string, buildType: string,
 *           sourceUri: string, sourceDigest: string,
 *           startedOn: string }} input real artifact digests plus the build's identity
 * @returns {Record<string, unknown>} an in-toto v1 statement carrying SLSA v1 provenance
 */
export function buildProvenance(input) {
  if (input.subjects.length === 0)
    throw new Error("provenance needs at least one subject");
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [...input.subjects]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, digest: { sha256: s.sha256 } })),
    predicateType: SLSA_PREDICATE_TYPE,
    predicate: {
      buildDefinition: {
        buildType: input.buildType,
        externalParameters: {
          source: {
            uri: input.sourceUri,
            digest: { gitCommit: input.sourceDigest },
          },
        },
        resolvedDependencies: [
          { uri: input.sourceUri, digest: { gitCommit: input.sourceDigest } },
        ],
      },
      runDetails: {
        builder: { id: input.builderId },
        metadata: {
          invocationId: sha256Hex(`${input.builderId} ${input.sourceDigest}`),
          startedOn: input.startedOn,
        },
      },
    },
  };
}

/**
 * Re-check a provenance statement against artifacts as they exist now.
 * `actual` maps artifact name → real sha256 hex computed from the file.
 *
 * @param {Record<string, unknown>} statement the attestation to check
 * @param {Record<string, string>} actual artifact name to real sha256 hex
 * @param {{ builderId?: string }} [expected] optional builder identity to pin
 * @returns {{ ok: boolean, reasons: string[] }} the verdict and every way the statement failed to describe reality
 */
export function verifyProvenance(statement, actual, expected = {}) {
  const reasons = [];
  if (statement?._type !== IN_TOTO_STATEMENT_TYPE)
    reasons.push("not an in-toto v1 statement");
  if (statement?.predicateType !== SLSA_PREDICATE_TYPE)
    reasons.push("not a SLSA v1 provenance predicate");
  const subjects = Array.isArray(statement?.subject) ? statement.subject : [];
  if (subjects.length === 0) reasons.push("statement vouches for no subject");
  for (const subject of subjects) {
    const claimed = subject?.digest?.sha256;
    if (typeof claimed !== "string") {
      reasons.push(`subject ${subject?.name ?? "(unnamed)"} carries no sha256`);
      continue;
    }
    const real = actual[subject.name];
    if (real === undefined)
      reasons.push(
        `subject ${subject.name} is not present in the artifact set`
      );
    else if (real !== claimed)
      reasons.push(
        `subject ${subject.name} digest mismatch (attested ${claimed.slice(0, 12)}…, actual ${real.slice(0, 12)}…)`
      );
  }
  const covered = new Set(subjects.map((s) => s?.name));
  for (const name of Object.keys(actual)) {
    if (!covered.has(name))
      reasons.push(
        `artifact ${name} is not covered by the provenance statement`
      );
  }
  const builderId = statement?.predicate?.runDetails?.builder?.id;
  if (expected.builderId !== undefined && builderId !== expected.builderId)
    reasons.push(
      `builder id ${String(builderId)} is not the expected ${expected.builderId}`
    );
  return { ok: reasons.length === 0, reasons };
}

/**
 * The release manifest the desktop updater verifies (W6.1). Same schema tag the
 * updater pins, so a manifest this repo produces is one the shipped verifier
 * accepts — and a manifest it cannot produce is one the updater must refuse.
 */
export function buildReleaseManifest(version, artifacts) {
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    version,
    artifacts: [...artifacts]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => ({ name: a.name, sha512: a.sha512 })),
  };
}

/** Short fingerprint of a release key — matches `keyIdFor` in the updater core. */
export function keyIdFor(publicKeyBase64) {
  return sha256Hex(Buffer.from(publicKeyBase64, "base64")).slice(0, 32);
}

/**
 * Sign a document's canonical bytes with a raw Ed25519 private key.
 * @param {unknown} document the payload to sign
 * @param {import("node:crypto").KeyObject} privateKey the Ed25519 private half
 * @param {string} publicKeyBase64 base64 raw 32-byte public half, used to derive the keyId
 * @returns {Record<string, string>} a detached signature envelope
 */
export function signDocument(document, privateKey, publicKeyBase64) {
  return {
    schema: RELEASE_SIGNATURE_SCHEMA,
    algorithm: "ed25519",
    keyId: keyIdFor(publicKeyBase64),
    signature: signBytes(
      null,
      Buffer.from(canonicalJson(document), "utf8"),
      privateKey
    ).toString("base64"),
  };
}

/**
 * Verify a detached signature envelope produced by {@link signDocument}.
 * Mirrors the updater's rule: the envelope's keyId only selects a candidate,
 * the cryptographic check is what grants trust.
 */
export function verifyDocument(document, envelope, publicKeyBase64) {
  if (envelope?.schema !== RELEASE_SIGNATURE_SCHEMA)
    return { ok: false, reason: "malformed-signature" };
  if (envelope.algorithm !== "ed25519")
    return { ok: false, reason: "unsupported-algorithm" };
  const raw = Buffer.from(publicKeyBase64, "base64");
  if (raw.byteLength !== 32) return { ok: false, reason: "malformed-key" };
  if (envelope.keyId !== keyIdFor(publicKeyBase64))
    return { ok: false, reason: "untrusted-key" };
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
  const signature = Buffer.from(envelope.signature ?? "", "base64");
  if (signature.byteLength !== 64)
    return { ok: false, reason: "malformed-signature" };
  const ok = verifyBytes(
    null,
    Buffer.from(canonicalJson(document), "utf8"),
    key,
    signature
  );
  return ok
    ? { ok: true, reason: "signature-verified" }
    : { ok: false, reason: "bad-signature" };
}
