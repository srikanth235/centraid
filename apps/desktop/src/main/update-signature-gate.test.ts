/*
 * W6.1 — the fetch half of the install gate (umbrella #842).
 *
 * The core's decision table is proven in update-signature-core.test.ts; this
 * file proves the gate feeds it honestly: that a 404 or a hostile mirror
 * becomes a REFUSAL rather than a pass, that the trust-anchor short-circuit
 * makes no network call at all, and that the shipping
 * {@link TRUSTED_RELEASE_KEYS} value refuses in a packaged build today.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";
import type { Mock } from "vitest";

import {
  canonicalJson,
  keyIdFor,
  RELEASE_MANIFEST_SCHEMA,
  RELEASE_SIGNATURE_SCHEMA,
} from "./update-signature-core.js";
import type { ReleaseManifest } from "./update-signature-core.js";
import {
  admitDownloadedUpdate,
  artifactFromUpdateInfo,
  fetchUpdateTrust,
  MAX_MANIFEST_BYTES,
  releaseAssetUrl,
  RELEASE_MANIFEST_FILE,
  RELEASE_SIGNATURE_FILE,
  TRUSTED_RELEASE_KEYS,
} from "./update-signature-gate.js";
import type { FetchText } from "./update-signature-gate.js";

const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
const VERSION = "0.6.0";
const ARTIFACT = {
  name: "Centraid-0.6.0.AppImage",
  sha512: "ZGlnZXN0LWJhc2U2NA==",
};

function keypair(seedByte: number) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from(PKCS8_ED25519_PREFIX, "hex"),
      Buffer.alloc(32, seedByte),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(12)
    .toString("base64");
  return { privateKey, publicKey, keyId: keyIdFor(publicKey) };
}

const release = keypair(0x33);
const trustedKeys = [{ keyId: release.keyId, publicKey: release.publicKey }];
const manifest: ReleaseManifest = {
  schema: RELEASE_MANIFEST_SCHEMA,
  version: VERSION,
  artifacts: [ARTIFACT],
};
const manifestText = JSON.stringify(manifest);
const signatureText = JSON.stringify({
  schema: RELEASE_SIGNATURE_SCHEMA,
  algorithm: "ed25519",
  keyId: release.keyId,
  signature: signBytes(
    null,
    Buffer.from(canonicalJson(manifest), "utf8"),
    release.privateKey
  ).toString("base64"),
});

function fetcherFor(bodies: Record<string, string>): Mock<FetchText> {
  return vi.fn<FetchText>(async (url: string) => {
    const body = bodies[url];
    if (body === undefined)
      return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, text: async () => body };
  });
}

const manifestUrl = releaseAssetUrl(VERSION, RELEASE_MANIFEST_FILE);
const signatureUrl = releaseAssetUrl(VERSION, RELEASE_SIGNATURE_FILE);

function gateInput(fetchText: FetchText) {
  return {
    packaged: true,
    version: VERSION,
    artifact: { ...ARTIFACT },
    fetchText,
    trustedKeys,
  };
}

describe(releaseAssetUrl, () => {
  test("points at the tag's release assets", () => {
    expect(manifestUrl).toBe(
      "https://github.com/srikanth235/centraid/releases/download/v0.6.0/centraid-release-manifest.json"
    );
  });
});

describe(artifactFromUpdateInfo, () => {
  test("takes the bare filename and digest from an electron-updater UpdateInfo", () => {
    expect(
      artifactFromUpdateInfo({
        version: VERSION,
        files: [{ url: "nested/path/Centraid-0.6.0.AppImage", sha512: "abc" }],
      })
    ).toStrictEqual({ name: "Centraid-0.6.0.AppImage", sha512: "abc" });
  });

  test("a feed with no files yields null, which the core refuses on", () => {
    expect(artifactFromUpdateInfo({ version: VERSION, files: [] })).toBeNull();
    expect(artifactFromUpdateInfo(null)).toBeNull();
    expect(artifactFromUpdateInfo({ files: [{ url: "x" }] })).toBeNull();
  });
});

describe(fetchUpdateTrust, () => {
  test("admits a release whose manifest and signature both check out", async () => {
    const fetchText = fetcherFor({
      [manifestUrl]: manifestText,
      [signatureUrl]: signatureText,
    });
    await expect(fetchUpdateTrust(gateInput(fetchText))).resolves.toMatchObject(
      {
        trusted: true,
        reason: "signature-verified",
      }
    );
    // Stronger than a call count: the gate must fetch the manifest and its
    // detached signature, and nothing else.
    expect(fetchText.mock.calls.map((call) => call[0])).toStrictEqual([
      manifestUrl,
      signatureUrl,
    ]);
  });

  test("REFUSAL: the signature asset 404s (an unsigned release)", async () => {
    const fetchText = fetcherFor({ [manifestUrl]: manifestText });
    await expect(fetchUpdateTrust(gateInput(fetchText))).resolves.toStrictEqual(
      {
        trusted: false,
        reason: "missing-signature",
      }
    );
  });

  test("REFUSAL: the transport throws — an unreachable host is not a pass", async () => {
    const fetchText: FetchText = vi.fn<FetchText>(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(fetchUpdateTrust(gateInput(fetchText))).resolves.toStrictEqual(
      {
        trusted: false,
        reason: "missing-manifest",
      }
    );
  });

  test("REFUSAL: an oversized body is dropped rather than parsed", async () => {
    const fetchText = fetcherFor({
      [manifestUrl]: "x".repeat(MAX_MANIFEST_BYTES + 1),
      [signatureUrl]: signatureText,
    });
    await expect(fetchUpdateTrust(gateInput(fetchText))).resolves.toStrictEqual(
      {
        trusted: false,
        reason: "missing-manifest",
      }
    );
  });

  test("REFUSAL: a mirror serving a valid manifest for another version", async () => {
    const fetchText = fetcherFor({
      [manifestUrl]: manifestText,
      [signatureUrl]: signatureText,
    });
    await expect(
      fetchUpdateTrust({ ...gateInput(fetchText), version: VERSION })
    ).resolves.toMatchObject({ trusted: true });
    const other = releaseAssetUrl("0.7.0", RELEASE_MANIFEST_FILE);
    const otherSig = releaseAssetUrl("0.7.0", RELEASE_SIGNATURE_FILE);
    const replay = fetcherFor({
      [other]: manifestText,
      [otherSig]: signatureText,
    });
    await expect(
      fetchUpdateTrust({ ...gateInput(replay), version: "0.7.0" })
    ).resolves.toMatchObject({ trusted: false, reason: "version-mismatch" });
  });

  test("no trust anchor short-circuits before any network call", async () => {
    const fetchText = fetcherFor({});
    await expect(
      fetchUpdateTrust({ ...gateInput(fetchText), trustedKeys: [] })
    ).resolves.toStrictEqual({ trusted: false, reason: "no-trust-anchor" });
    expect(fetchText).not.toHaveBeenCalled();
  });

  test("unpackaged dev short-circuits before any network call", async () => {
    const fetchText = fetcherFor({});
    await expect(
      fetchUpdateTrust({ ...gateInput(fetchText), packaged: false })
    ).resolves.toStrictEqual({ trusted: true, reason: "unpackaged-dev" });
    expect(fetchText).not.toHaveBeenCalled();
  });
});

describe(admitDownloadedUpdate, () => {
  test("returns true and logs the admitted verdict", async () => {
    const lines: string[] = [];
    const info = vi
      .spyOn(console, "info")
      .mockImplementation((line: unknown) => void lines.push(String(line)));
    const fetchText = fetcherFor({
      [manifestUrl]: manifestText,
      [signatureUrl]: signatureText,
    });
    await expect(admitDownloadedUpdate(gateInput(fetchText))).resolves.toBe(
      true
    );
    expect(lines.join("\n")).toContain("admitted");
    info.mockRestore();
  });

  test("REFUSAL is loud: false plus an error line naming the reason", async () => {
    const lines: string[] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((line: unknown) => void lines.push(String(line)));
    const fetchText = fetcherFor({ [manifestUrl]: manifestText });
    await expect(admitDownloadedUpdate(gateInput(fetchText))).resolves.toBe(
      false
    );
    expect(lines.join("\n")).toContain("REFUSED (missing-signature)");
    error.mockRestore();
  });
});

describe("update-watcher wiring (W6.1)", () => {
  test("the packaged install path gates through admitDownloadedUpdate", () => {
    const src = readFileSync(
      path.join(import.meta.dirname, "update-watcher.ts"),
      "utf8"
    );
    expect(src).toMatch(/\bfrom\s+["']\.\/update-signature-gate\.js["']/u);
    expect(src).toContain("artifactFromUpdateInfo(info)");
    const gate = src.indexOf("await admitDownloadedUpdate(");
    const ready = src.indexOf("packagedDownloadReady = true");
    expect(gate).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(gate);
    expect(src.slice(gate, ready)).toContain("if (!trusted) return;");
  });
});

describe("shipped trust anchors (#842 W6.1 blocked-external)", () => {
  test("no release key is enrolled yet, so a packaged build refuses every update", async () => {
    expect(TRUSTED_RELEASE_KEYS).toHaveLength(0);
    const lines: string[] = [];
    const error = vi
      .spyOn(console, "error")
      .mockImplementation((line: unknown) => void lines.push(String(line)));
    await expect(
      admitDownloadedUpdate({
        packaged: true,
        version: VERSION,
        artifact: { ...ARTIFACT },
        fetchText: fetcherFor({
          [manifestUrl]: manifestText,
          [signatureUrl]: signatureText,
        }),
      })
    ).resolves.toBe(false);
    expect(lines.join("\n")).toContain("REFUSED (no-trust-anchor)");
    error.mockRestore();
  });
});
