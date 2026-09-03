/*
 * W6.1 refusal proof (umbrella #842).
 *
 * These tests sign with REAL Ed25519 keys — deterministic ones, built from
 * fixed seeds so a failure replays exactly — and then verify with the shipping
 * verifier. Nothing is stubbed on the crypto path, so a verifier that stopped
 * verifying cannot pass this file: the paired sabotage cases (unsigned,
 * wrong-signed, tampered payload) only go green when a real signature check
 * actually rejects them.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
} from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  canonicalJson,
  keyIdFor,
  parseReleaseManifest,
  parseReleaseSignature,
  RELEASE_MANIFEST_SCHEMA,
  RELEASE_SIGNATURE_SCHEMA,
  resolveUpdateTrust,
  verifyManifestSignature,
} from "./update-signature-core.js";
import type {
  ReleaseManifest,
  TrustedReleaseKey,
} from "./update-signature-core.js";

const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";

function keypair(seedByte: number) {
  const seed = Buffer.alloc(32, seedByte);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from(PKCS8_ED25519_PREFIX, "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");
  return { privateKey, publicKey, keyId: keyIdFor(publicKey) };
}

const release = keypair(0x11);
const attacker = keypair(0x22);
const trustedKeys: TrustedReleaseKey[] = [
  { keyId: release.keyId, publicKey: release.publicKey },
];

const VERSION = "0.6.0";
const ARTIFACT = {
  name: "Centraid-0.6.0-arm64.dmg",
  sha512: "Y2VudHJhaWQtcGF5bG9hZC1kaWdlc3QtZm9yLXRlc3Rz",
};

function manifestFor(
  overrides: Partial<ReleaseManifest> = {}
): ReleaseManifest {
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    version: VERSION,
    artifacts: [ARTIFACT],
    ...overrides,
  };
}

function signManifest(manifest: ReleaseManifest, signer = release) {
  return JSON.stringify({
    schema: RELEASE_SIGNATURE_SCHEMA,
    algorithm: "ed25519",
    keyId: signer.keyId,
    signature: signBytes(
      null,
      Buffer.from(canonicalJson(manifest), "utf8"),
      signer.privateKey
    ).toString("base64"),
  });
}

function trustedInput() {
  const manifest = manifestFor();
  return {
    packaged: true,
    trustedKeys,
    version: VERSION,
    artifact: { ...ARTIFACT },
    manifestText: JSON.stringify(manifest),
    signatureText: signManifest(manifest),
  };
}

describe(canonicalJson, () => {
  test("orders keys so re-serialisation cannot change the signed bytes", () => {
    expect(canonicalJson({ b: 1, a: [3, 2] })).toBe('{"a":[3,2],"b":1}');
    expect(canonicalJson({ a: [3, 2], b: 1 })).toBe(
      canonicalJson({ b: 1, a: [3, 2] })
    );
  });

  test("array order is signed — reordering artifacts changes the bytes", () => {
    expect(canonicalJson({ artifacts: ["a", "b"] })).not.toBe(
      canonicalJson({ artifacts: ["b", "a"] })
    );
  });

  test("nested objects are canonicalised recursively", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });
});

describe("parse guards", () => {
  test("a manifest with the wrong schema tag is not a manifest", () => {
    expect(
      parseReleaseManifest(JSON.stringify(manifestFor({ schema: "other/1" })))
    ).toBeNull();
  });

  test("a manifest with no artifacts is rejected", () => {
    expect(
      parseReleaseManifest(JSON.stringify(manifestFor({ artifacts: [] })))
    ).toBeNull();
  });

  test("an artifact missing its digest is rejected", () => {
    const text = JSON.stringify({
      schema: RELEASE_MANIFEST_SCHEMA,
      version: VERSION,
      artifacts: [{ name: "x.dmg" }],
    });
    expect(parseReleaseManifest(text)).toBeNull();
  });

  test("non-JSON is refused rather than thrown", () => {
    expect(parseReleaseManifest("not json at all")).toBeNull();
    expect(parseReleaseSignature("<html>404</html>")).toBeNull();
  });
});

describe("verifyManifestSignature — real Ed25519", () => {
  test("a manifest signed by the pinned release key verifies", () => {
    const manifest = manifestFor();
    const signature = parseReleaseSignature(signManifest(manifest));
    expect(signature).not.toBeNull();
    const verdict = verifyManifestSignature({
      manifest,
      signature: signature!,
      trustedKeys,
    });
    expect(verdict).toStrictEqual({
      trusted: true,
      reason: "signature-verified",
      keyId: release.keyId,
    });
  });

  test("REFUSAL: no pinned key at all is never a pass", () => {
    const manifest = manifestFor();
    const verdict = verifyManifestSignature({
      manifest,
      signature: parseReleaseSignature(signManifest(manifest))!,
      trustedKeys: [],
    });
    expect(verdict).toStrictEqual({
      trusted: false,
      reason: "no-trust-anchor",
    });
  });

  test("REFUSAL: a real signature by an unpinned key is rejected", () => {
    const manifest = manifestFor();
    const verdict = verifyManifestSignature({
      manifest,
      signature: parseReleaseSignature(signManifest(manifest, attacker))!,
      trustedKeys,
    });
    expect(verdict.trusted).toBe(false);
    expect(verdict).toMatchObject({ reason: "untrusted-key" });
  });

  test("REFUSAL: an attacker key that claims the release keyId still fails the math", () => {
    const manifest = manifestFor();
    const forged = JSON.parse(signManifest(manifest, attacker)) as {
      keyId: string;
    };
    forged.keyId = release.keyId;
    const verdict = verifyManifestSignature({
      manifest,
      signature: parseReleaseSignature(JSON.stringify(forged))!,
      trustedKeys,
    });
    expect(verdict).toMatchObject({ trusted: false, reason: "bad-signature" });
  });

  test("REFUSAL: a signature over a different manifest does not transfer", () => {
    const signedManifest = manifestFor();
    const servedManifest = manifestFor({ version: "9.9.9" });
    const verdict = verifyManifestSignature({
      manifest: servedManifest,
      signature: parseReleaseSignature(signManifest(signedManifest))!,
      trustedKeys,
    });
    expect(verdict).toMatchObject({ trusted: false, reason: "bad-signature" });
  });

  test("REFUSAL: a non-Ed25519 algorithm claim is not honoured", () => {
    const manifest = manifestFor();
    const envelope = JSON.parse(signManifest(manifest)) as {
      algorithm: string;
    };
    envelope.algorithm = "none";
    const verdict = verifyManifestSignature({
      manifest,
      signature: parseReleaseSignature(JSON.stringify(envelope))!,
      trustedKeys,
    });
    expect(verdict).toMatchObject({
      trusted: false,
      reason: "unsupported-algorithm",
    });
  });

  test("REFUSAL: a truncated signature is rejected before verification", () => {
    const manifest = manifestFor();
    const envelope = JSON.parse(signManifest(manifest)) as {
      signature: string;
    };
    envelope.signature = Buffer.from(envelope.signature, "base64")
      .subarray(0, 40)
      .toString("base64");
    const verdict = verifyManifestSignature({
      manifest,
      signature: parseReleaseSignature(JSON.stringify(envelope))!,
      trustedKeys,
    });
    expect(verdict).toMatchObject({
      trusted: false,
      reason: "malformed-signature",
    });
  });
});

describe("cross-implementation golden vector (W6.2 signer → W6.1 verifier)", () => {
  const GOLDEN_MANIFEST =
    '{"schema":"centraid.release-manifest/1","version":"0.6.0","artifacts":[{"name":"Centraid-0.6.0.dmg","sha512":"Z29sZGVuLXZlY3Rvci1kaWdlc3Q="}]}';
  const GOLDEN_PUBLIC_KEY = "yFOtDwzSthmuqSzuxP1Wok1kmdWEznklfkXP2BObYKc=";
  const GOLDEN_KEY_ID = "d2f381d7b0b5f1d39239f186fdee4dd3";
  const GOLDEN_SIGNATURE =
    '{"schema":"centraid.release-signature/1","algorithm":"ed25519","keyId":"d2f381d7b0b5f1d39239f186fdee4dd3","signature":"atEzvpd8Tf0LVPnf0JzZR5UpoVMtfkEDA3uwpejgzDEFEj2wbBfCiWhL2SHWqwDSdmtfENiBw7Y5GCkQIGu9Bw=="}';

  test("the release tooling's keyId derivation matches the updater's", () => {
    expect(keyIdFor(GOLDEN_PUBLIC_KEY)).toBe(GOLDEN_KEY_ID);
  });

  test("a manifest signed by the release tooling is admitted by the shipped verifier", () => {
    expect(
      resolveUpdateTrust({
        packaged: true,
        trustedKeys: [{ keyId: GOLDEN_KEY_ID, publicKey: GOLDEN_PUBLIC_KEY }],
        version: "0.6.0",
        artifact: {
          name: "Centraid-0.6.0.dmg",
          sha512: "Z29sZGVuLXZlY3Rvci1kaWdlc3Q=",
        },
        manifestText: GOLDEN_MANIFEST,
        signatureText: GOLDEN_SIGNATURE,
      })
    ).toMatchObject({ trusted: true, reason: "signature-verified" });
  });

  test("REFUSAL: the same vector with one byte of the manifest changed", () => {
    expect(
      resolveUpdateTrust({
        packaged: true,
        trustedKeys: [{ keyId: GOLDEN_KEY_ID, publicKey: GOLDEN_PUBLIC_KEY }],
        version: "0.6.0",
        artifact: {
          name: "Centraid-0.6.0.dmg",
          sha512: "Z29sZGVuLXZlY3Rvci1kaWdlc3Q=",
        },
        manifestText: GOLDEN_MANIFEST.replace("0.6.0", "0.6.1"),
        signatureText: GOLDEN_SIGNATURE,
      })
    ).toMatchObject({ trusted: false, reason: "bad-signature" });
  });
});

describe("resolveUpdateTrust — install policy", () => {
  test("a fully-signed, digest-matching update is admitted", () => {
    expect(resolveUpdateTrust(trustedInput())).toMatchObject({
      trusted: true,
      reason: "signature-verified",
    });
  });

  test("unpackaged dev is not gated — it reloads its own dist, not a feed", () => {
    expect(
      resolveUpdateTrust({
        ...trustedInput(),
        packaged: false,
        trustedKeys: [],
        manifestText: null,
        signatureText: null,
      })
    ).toStrictEqual({ trusted: true, reason: "unpackaged-dev" });
  });

  test("REFUSAL: a packaged build with no release key refuses (fail closed)", () => {
    expect(
      resolveUpdateTrust({ ...trustedInput(), trustedKeys: [] })
    ).toStrictEqual({
      trusted: false,
      reason: "no-trust-anchor",
    });
  });

  test("REFUSAL: unsigned update — signature asset absent", () => {
    expect(
      resolveUpdateTrust({ ...trustedInput(), signatureText: null })
    ).toStrictEqual({
      trusted: false,
      reason: "missing-signature",
    });
  });

  test("REFUSAL: unsigned update — manifest asset absent", () => {
    expect(
      resolveUpdateTrust({ ...trustedInput(), manifestText: null })
    ).toStrictEqual({
      trusted: false,
      reason: "missing-manifest",
    });
  });

  test("REFUSAL: wrong-signed update — signed by an unpinned key", () => {
    const manifest = manifestFor();
    expect(
      resolveUpdateTrust({
        ...trustedInput(),
        manifestText: JSON.stringify(manifest),
        signatureText: signManifest(manifest, attacker),
      })
    ).toMatchObject({ trusted: false, reason: "untrusted-key" });
  });

  test("REFUSAL: tampered manifest — a digest swapped after signing", () => {
    const manifest = manifestFor();
    const signatureText = signManifest(manifest);
    const tampered = manifestFor({
      artifacts: [{ name: ARTIFACT.name, sha512: "dGFtcGVyZWQtZGlnZXN0" }],
    });
    expect(
      resolveUpdateTrust({
        ...trustedInput(),
        manifestText: JSON.stringify(tampered),
        signatureText,
      })
    ).toMatchObject({ trusted: false, reason: "bad-signature" });
  });

  test("REFUSAL: tampered payload — downloaded bytes do not match the signed digest", () => {
    expect(
      resolveUpdateTrust({
        ...trustedInput(),
        artifact: {
          name: ARTIFACT.name,
          sha512: "c3dhcHBlZC1wYXlsb2FkLWJ5dGVz",
        },
      })
    ).toMatchObject({ trusted: false, reason: "payload-mismatch" });
  });

  test("REFUSAL: an artifact the manifest never vouched for", () => {
    expect(
      resolveUpdateTrust({
        ...trustedInput(),
        artifact: { name: "Centraid-evil.exe", sha512: ARTIFACT.sha512 },
      })
    ).toMatchObject({ trusted: false, reason: "unknown-artifact" });
  });

  test("REFUSAL: a validly-signed manifest for a different version (rollback/replay)", () => {
    expect(
      resolveUpdateTrust({ ...trustedInput(), version: "0.5.0" })
    ).toMatchObject({
      trusted: false,
      reason: "version-mismatch",
    });
  });

  test("REFUSAL: the feed omitted the artifact digest entirely", () => {
    expect(
      resolveUpdateTrust({ ...trustedInput(), artifact: null })
    ).toStrictEqual({
      trusted: false,
      reason: "missing-artifact-digest",
    });
  });

  test("REFUSAL: a garbage manifest body (an HTML error page from a mirror)", () => {
    expect(
      resolveUpdateTrust({
        ...trustedInput(),
        manifestText: "<html>404 Not Found</html>",
      })
    ).toStrictEqual({ trusted: false, reason: "malformed-manifest" });
  });
});
