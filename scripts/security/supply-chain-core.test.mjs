import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  buildProvenance,
  buildReleaseManifest,
  buildSbom,
  canonicalJson,
  IN_TOTO_STATEMENT_TYPE,
  keyIdFor,
  parseBunLock,
  purlFor,
  RELEASE_MANIFEST_SCHEMA,
  RELEASE_METADATA_FILES,
  sha256Hex,
  sha512Base64,
  signDocument,
  verifyDocument,
  verifyProvenance,
  verifySbom,
} from "./supply-chain-core.mjs";

const root = path.resolve(import.meta.dirname, "../..");

function keypair(seedByte) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, seedByte),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");
  return { privateKey, publicKey };
}

const release = keypair(0x77);
const attacker = keypair(0x88);

const LOCK_FIXTURE = `{
  "lockfileVersion": 1,
  "packages": {
    "@scope/pkg": ["@scope/pkg@1.2.3", "", { "dependencies": {} }, "sha512-AAAA"],

    "left-pad": ["left-pad@1.0.0", "", {}, "sha512-BBBB"],

    "packages/vault": ["@centraid/vault@workspace:packages/vault"],
  }
}`;

test("canonicalJson sorts keys and is stable under re-serialisation", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(
    canonicalJson(JSON.parse('{"a":2,"b":1}')),
    canonicalJson({ b: 1, a: 2 })
  );
  assert.notEqual(canonicalJson(["a", "b"]), canonicalJson(["b", "a"]));
  assert.equal(
    canonicalJson({ nested: { z: 1, a: { y: 2, x: 3 } } }),
    '{"nested":{"a":{"x":3,"y":2},"z":1}}'
  );
});

test("parseBunLock reads names, versions, integrity, and workspace membership", () => {
  const { packages, errors } = parseBunLock(LOCK_FIXTURE);
  assert.deepEqual(errors, []);
  assert.equal(packages.length, 3);
  assert.deepEqual(packages[0], {
    name: "@centraid/vault",
    version: "workspace:packages/vault",
    integrity: null,
    workspace: true,
  });
  const scoped = packages.find((pkg) => pkg.name === "@scope/pkg");
  assert.equal(scoped.version, "1.2.3");
  assert.equal(scoped.integrity, "sha512-AAAA");
  assert.equal(scoped.workspace, false);
});

test("parseBunLock refuses to report an empty inventory silently", () => {
  const { errors } = parseBunLock('{"lockfileVersion": 1}');
  assert.match(errors.join(" "), /yielded no packages/u);
});

test("parseBunLock reads the repo's real bun.lock", () => {
  const { packages, errors } = parseBunLock(
    readFileSync(path.join(root, "bun.lock"), "utf8")
  );
  assert.deepEqual(errors, []);
  assert.ok(
    packages.length > 500,
    `expected a real inventory, got ${packages.length}`
  );
  assert.ok(
    packages.some((pkg) => pkg.workspace),
    "no workspace package found"
  );
  assert.ok(
    packages.filter((pkg) => pkg.integrity !== null).length >
      packages.length / 2
  );
});

test("purlFor encodes scoped names per the purl npm type", () => {
  assert.equal(purlFor("left-pad", "1.0.0"), "pkg:npm/left-pad@1.0.0");
  assert.equal(purlFor("@scope/pkg", "1.2.3"), "pkg:npm/%40scope/pkg@1.2.3");
});

test("buildSbom is deterministic and derives its serial from content", () => {
  const input = {
    packages: parseBunLock(LOCK_FIXTURE).packages,
    component: { name: "centraid-monorepo", version: "0.6.0" },
    timestamp: "2026-08-21T00:00:00.000Z",
  };
  const first = buildSbom(input);
  const second = buildSbom(input);
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.match(first.serialNumber, /^urn:uuid:[0-9a-f-]+$/u);
  assert.equal(first.bomFormat, "CycloneDX");
  assert.equal(first.specVersion, "1.6");
  assert.equal(first.components.length, 3);
  const changed = buildSbom({ ...input, packages: input.packages.slice(1) });
  assert.notEqual(changed.serialNumber, first.serialNumber);
});

test("buildSbom carries integrity hashes as hex CycloneDX hashes", () => {
  const bom = buildSbom({
    packages: parseBunLock(LOCK_FIXTURE).packages,
    component: { name: "x", version: "1" },
    timestamp: "2026-08-21T00:00:00.000Z",
  });
  const leftPad = bom.components.find(
    (component) => component.name === "left-pad"
  );
  assert.deepEqual(leftPad.hashes, [
    { alg: "SHA-512", content: Buffer.from("BBBB", "base64").toString("hex") },
  ]);
});

test("verifySbom accepts a matching BOM and REFUSES drift in both directions", () => {
  const packages = parseBunLock(LOCK_FIXTURE).packages;
  const bom = buildSbom({
    packages,
    component: { name: "x", version: "1" },
    timestamp: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(verifySbom(bom, packages).ok, true);

  const added = verifySbom(bom, [
    ...packages,
    { name: "evil", version: "9.9.9", integrity: null, workspace: false },
  ]);
  assert.equal(added.ok, false);
  assert.deepEqual(added.missing, ["evil@9.9.9"]);

  const stale = verifySbom(bom, packages.slice(1));
  assert.equal(stale.ok, false);
  assert.equal(stale.extra.length, 1);

  assert.equal(verifySbom({ hello: "world" }, packages).ok, false);
});

test("buildProvenance sorts subjects and refuses an empty subject set", () => {
  const statement = buildProvenance({
    subjects: [
      { name: "b.dmg", sha256: sha256Hex("b") },
      { name: "a.exe", sha256: sha256Hex("a") },
    ],
    builderId: "https://github.com/o/r/.github/workflows/x.yml@refs/tags/v1",
    buildType: "https://example.invalid/build@v1",
    sourceUri: "https://github.com/o/r",
    sourceDigest: "deadbeef",
    startedOn: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(statement._type, IN_TOTO_STATEMENT_TYPE);
  assert.deepEqual(
    statement.subject.map((s) => s.name),
    ["a.exe", "b.dmg"]
  );
  assert.throws(() =>
    buildProvenance({
      subjects: [],
      builderId: "x",
      buildType: "x",
      sourceUri: "x",
      sourceDigest: "x",
      startedOn: "x",
    })
  );
});

test("verifyProvenance accepts real digests and REFUSES every way they can lie", () => {
  const bytes = {
    "a.exe": Buffer.from("artifact a"),
    "b.dmg": Buffer.from("artifact b"),
  };
  const actual = Object.fromEntries(
    Object.entries(bytes).map(([name, data]) => [name, sha256Hex(data)])
  );
  const builderId =
    "https://github.com/o/r/.github/workflows/x.yml@refs/tags/v1";
  const statement = buildProvenance({
    subjects: Object.entries(actual).map(([name, sha256]) => ({
      name,
      sha256,
    })),
    builderId,
    buildType: "https://example.invalid/build@v1",
    sourceUri: "https://github.com/o/r",
    sourceDigest: "deadbeef",
    startedOn: "2026-08-21T00:00:00.000Z",
  });
  assert.equal(verifyProvenance(statement, actual, { builderId }).ok, true);

  const tampered = { ...actual, "b.dmg": sha256Hex("something else entirely") };
  const swapped = verifyProvenance(statement, tampered);
  assert.equal(swapped.ok, false);
  assert.match(swapped.reasons.join(" "), /b\.dmg digest mismatch/u);

  const smuggled = verifyProvenance(statement, {
    ...actual,
    "extra.sh": sha256Hex("payload"),
  });
  assert.equal(smuggled.ok, false);
  assert.match(smuggled.reasons.join(" "), /extra\.sh is not covered/u);

  const absent = verifyProvenance(statement, { "a.exe": actual["a.exe"] });
  assert.equal(absent.ok, false);

  const elsewhere = verifyProvenance(statement, actual, {
    builderId: "https://evil.invalid/builder",
  });
  assert.equal(elsewhere.ok, false);
  assert.match(elsewhere.reasons.join(" "), /is not the expected/u);

  assert.equal(
    verifyProvenance({ _type: "something/else", subject: [] }, actual).ok,
    false
  );
});

test("signDocument / verifyDocument round-trip with real Ed25519", () => {
  const manifest = buildReleaseManifest("0.6.0", [
    {
      name: "Centraid-0.6.0.dmg",
      sha512: sha512Base64(Buffer.from("installer")),
    },
  ]);
  const envelope = signDocument(
    manifest,
    release.privateKey,
    release.publicKey
  );
  assert.equal(envelope.keyId, keyIdFor(release.publicKey));
  assert.deepEqual(verifyDocument(manifest, envelope, release.publicKey), {
    ok: true,
    reason: "signature-verified",
  });
});

test("REFUSAL: a signature by another key does not verify against the release key", () => {
  const manifest = buildReleaseManifest("0.6.0", [
    { name: "x.dmg", sha512: "AAAA" },
  ]);
  const forged = signDocument(
    manifest,
    attacker.privateKey,
    attacker.publicKey
  );
  assert.equal(verifyDocument(manifest, forged, release.publicKey).ok, false);
  const relabelled = { ...forged, keyId: keyIdFor(release.publicKey) };
  assert.deepEqual(verifyDocument(manifest, relabelled, release.publicKey), {
    ok: false,
    reason: "bad-signature",
  });
});

test("REFUSAL: a tampered manifest breaks a genuine signature", () => {
  const manifest = buildReleaseManifest("0.6.0", [
    { name: "x.dmg", sha512: "AAAA" },
  ]);
  const envelope = signDocument(
    manifest,
    release.privateKey,
    release.publicKey
  );
  const tampered = buildReleaseManifest("0.6.0", [
    { name: "x.dmg", sha512: "QkJCQg==" },
  ]);
  assert.deepEqual(verifyDocument(tampered, envelope, release.publicKey), {
    ok: false,
    reason: "bad-signature",
  });
});

test("REFUSAL: malformed envelopes and keys are rejected before verification", () => {
  const manifest = buildReleaseManifest("0.6.0", [
    { name: "x.dmg", sha512: "AAAA" },
  ]);
  const envelope = signDocument(
    manifest,
    release.privateKey,
    release.publicKey
  );
  assert.equal(
    verifyDocument(
      manifest,
      { ...envelope, schema: "other/1" },
      release.publicKey
    ).reason,
    "malformed-signature"
  );
  assert.equal(
    verifyDocument(
      manifest,
      { ...envelope, algorithm: "none" },
      release.publicKey
    ).reason,
    "unsupported-algorithm"
  );
  assert.equal(
    verifyDocument(manifest, envelope, "c2hvcnQ=").reason,
    "malformed-key"
  );
  const truncated = {
    ...envelope,
    signature: Buffer.from(envelope.signature, "base64")
      .subarray(0, 32)
      .toString("base64"),
  };
  assert.equal(
    verifyDocument(manifest, truncated, release.publicKey).reason,
    "malformed-signature"
  );
});

test("buildReleaseManifest emits the exact schema the shipped updater pins", () => {
  assert.equal(RELEASE_MANIFEST_SCHEMA, "centraid.release-manifest/1");
  const manifest = buildReleaseManifest("0.6.0", [
    { name: "b.dmg", sha512: "QQ==" },
    { name: "a.exe", sha512: "Qg==" },
  ]);
  assert.equal(manifest.schema, "centraid.release-manifest/1");
  assert.deepEqual(
    manifest.artifacts.map((a) => a.name),
    ["a.exe", "b.dmg"]
  );
});

test("release metadata files are excluded from the digest set", () => {
  assert.ok(RELEASE_METADATA_FILES.has("centraid-release-manifest.json"));
  assert.ok(RELEASE_METADATA_FILES.has("centraid-release-manifest.sig.json"));
});
