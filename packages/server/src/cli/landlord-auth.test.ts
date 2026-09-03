import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

import { daemonKeyStore } from "./key-store.js";
import {
  landlordBearerForDataDir,
  landlordBearerForEndpointSecret,
} from "./landlord-auth.js";
import { daemonLayoutFor } from "./paths.js";

const roots: string[] = [];

describe("landlord-auth", () => {
  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  test("the derived bearer is stable for an endpoint secret and unique to it", () => {
    const secret = Buffer.alloc(32, 0x7a);
    const bearer = landlordBearerForEndpointSecret(secret);

    expect(bearer).toBe(
      landlordBearerForEndpointSecret(Buffer.alloc(32, 0x7a))
    );
    expect(bearer).toMatch(/^[0-9a-f]{64}$/u);
    expect(landlordBearerForEndpointSecret(Buffer.alloc(32, 0x7b))).not.toBe(
      bearer
    );
    expect(bearer).not.toBe(secret.toString("hex"));
  });

  test("a data dir derives the bearer of the endpoint key already under its custody", async () => {
    const dataDir = await tempDir("landlord-derive-");
    const credentialRoot = await tempDir("landlord-derive-credentials-");
    roots.push(dataDir, credentialRoot);
    const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };
    const keysDir = daemonLayoutFor(dataDir).keysDir;
    const secret = daemonKeyStore(keysDir, { env }).create("endpoint-key.bin");

    const previous = process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT;
    process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT = credentialRoot;
    try {
      expect(landlordBearerForDataDir(dataDir)).toBe(
        landlordBearerForEndpointSecret(secret)
      );
    } finally {
      if (previous === undefined)
        delete process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT;
      else process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT = previous;
    }
  });

  test("an explicit master key derives the same bearer the daemon serves with", async () => {
    const dataDir = await tempDir("landlord-master-key-");
    roots.push(dataDir);
    const masterKey = Buffer.alloc(32, 0x31);
    const keysDir = daemonLayoutFor(dataDir).keysDir;
    const secret = new KeyStore(keysDir, {
      protector: aesGcmKeyProtector(masterKey),
    }).create("endpoint-key.bin");

    expect(landlordBearerForDataDir(dataDir, { masterKey })).toBe(
      landlordBearerForEndpointSecret(secret)
    );
  });

  test("deriving never mints the endpoint identity and never throws on unreadable custody", async () => {
    const dataDir = await tempDir("landlord-absent-");
    roots.push(dataDir);
    const keysDir = daemonLayoutFor(dataDir).keysDir;
    const masterKey = Buffer.alloc(32, 0x41);

    expect(landlordBearerForDataDir(dataDir, { masterKey })).toBeUndefined();
    await expect(fs.readdir(keysDir).catch(() => [])).resolves.not.toContain(
      "endpoint-key.bin"
    );

    new KeyStore(keysDir, { protector: aesGcmKeyProtector(masterKey) }).create(
      "endpoint-key.bin"
    );
    expect(
      landlordBearerForDataDir(dataDir, { masterKey: Buffer.alloc(32, 0x42) })
    ).toBeUndefined();
    expect(landlordBearerForDataDir(dataDir, { masterKey })).toMatch(
      /^[0-9a-f]{64}$/u
    );

    const copied = await tempDir("landlord-copied-");
    roots.push(copied);
    await fs.cp(dataDir, copied, { recursive: true });
    expect(landlordBearerForDataDir(copied, { masterKey })).toBe(
      landlordBearerForDataDir(dataDir, { masterKey })
    );
  });

  test("an endpoint key stored outside the layout is not mistaken for this data dir", async () => {
    const dataDir = await tempDir("landlord-wrong-dir-");
    roots.push(dataDir);
    const masterKey = Buffer.alloc(32, 0x51);
    new KeyStore(path.join(dataDir, "not-keys"), {
      protector: aesGcmKeyProtector(masterKey),
    }).create("endpoint-key.bin");

    expect(landlordBearerForDataDir(dataDir, { masterKey })).toBeUndefined();
  });
});
