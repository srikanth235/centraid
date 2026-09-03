import fs, { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  clearGatewayCredentials,
  desktopGatewayKeyStore,
  deviceIrohKeyPersistence,
  getOrCreateGatewayWrappingKey,
  readLocalLoopbackToken,
  storeLocalLoopbackToken,
} from "./gateway-secrets.js";

const mocked = vi.hoisted(() => ({
  encryptionAvailable: false,
  isPackaged: false,
  secretsFile: "",
}));

vi.mock(import("electron"), () => ({
  app: {
    get isPackaged(): boolean {
      return mocked.isPackaged;
    },
  } as unknown as Electron.App,
  safeStorage: {
    decryptString: (value: Buffer) => value.toString("utf8"),
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    isEncryptionAvailable: () => mocked.encryptionAvailable,
    decryptStringAsync: (value: Buffer) =>
      Promise.resolve({
        result: value.toString("utf8"),
        shouldReEncrypt: false,
      }),
    encryptStringAsync: (value: string) =>
      Promise.resolve(Buffer.from(value, "utf8")),
    getSelectedStorageBackend: () => "unknown" as const,
    isAsyncEncryptionAvailable: () =>
      Promise.resolve(mocked.encryptionAvailable),
    setUsePlainTextEncryption: () => undefined,
  },
}));

vi.mock(import("./gateway-paths.js"), () => ({
  connectionSecretsFile: () => mocked.secretsFile,
}));

describe("gateway-secrets", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mocked.encryptionAvailable = false;
    mocked.isPackaged = false;
  });

  test("Linux without libsecret warns and falls back to a 0600 device-local file", async () => {
    const root = await tempDir("gateway-secrets-linux-");
    mocked.secretsFile = path.join(root, "connection-secrets.bin");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const warn = vi.spyOn(console, "warn").mockReturnValue(undefined);

    const key = getOrCreateGatewayWrappingKey("local");

    expect(key).toHaveLength(32);
    expect(readFileSync(mocked.secretsFile, "utf8")).toMatch(
      /^CENTRAID-DEVICE-SECRETS-V1\n/u
    );
    expect(statSync(mocked.secretsFile).mode & 0o777).toBe(0o600);
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/libsecret.*0600/iu)
    );
    expect(getOrCreateGatewayWrappingKey("local")).toStrictEqual(key);
  });

  test("embedded gateway envelopes require the originating desktop custody key", async () => {
    mocked.encryptionAvailable = true;
    const sourceDeviceDir = await tempDir("gateway-secrets-source-");
    const copiedDeviceDir = await tempDir("gateway-secrets-copy-");
    const dataDir = await tempDir("gateway-secrets-data-");

    mocked.secretsFile = path.join(sourceDeviceDir, "connection-secrets.bin");
    desktopGatewayKeyStore(dataDir, "local").store(
      "vault.sealkey",
      Buffer.alloc(32, 7)
    );

    mocked.secretsFile = path.join(copiedDeviceDir, "connection-secrets.bin");
    expect(() =>
      desktopGatewayKeyStore(dataDir, "local").load("vault.sealkey")
    ).toThrow(/authentication failed/iu);
  });

  test("one encrypted device store owns iroh keys, loopback tokens, and fallback adoption", async () => {
    const root = await tempDir("gateway-secrets-all-credentials-");
    mocked.secretsFile = path.join(root, "connection-secrets.bin");
    mocked.encryptionAvailable = true;
    const persistence = deviceIrohKeyPersistence("remote");

    expect(persistence.load()).toBeNull();
    persistence.store(Uint8Array.from([1, 2, 3, 4]));
    expect(persistence.load()).toStrictEqual(Uint8Array.from([1, 2, 3, 4]));
    expect(readLocalLoopbackToken("local")).toBeUndefined();
    storeLocalLoopbackToken("local", "ephemeral-loopback-token");
    expect(readLocalLoopbackToken("local")).toBe("ephemeral-loopback-token");
    clearGatewayCredentials("remote");
    expect(persistence.load()).toBeNull();
    clearGatewayCredentials("remote");

    mocked.secretsFile = path.join(root, "fallback-secrets.bin");
    mocked.encryptionAvailable = false;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const fallbackKey = getOrCreateGatewayWrappingKey("fallback");
    expect(readFileSync(mocked.secretsFile, "utf8")).toMatch(
      /^CENTRAID-DEVICE-SECRETS-V1\n/u
    );
    mocked.encryptionAvailable = true;
    expect(getOrCreateGatewayWrappingKey("fallback")).toStrictEqual(
      fallbackKey
    );
    expect(readFileSync(mocked.secretsFile, "utf8")).not.toMatch(
      /^CENTRAID-DEVICE-SECRETS-V1\n/u
    );
  });

  test("the dev hatch bypasses the keychain, without rewrites, and only unpackaged", async () => {
    const root = await tempDir("gateway-secrets-hatch-");
    mocked.secretsFile = path.join(root, "connection-secrets.bin");
    mocked.encryptionAvailable = true;
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("CENTRAID_INSECURE_DEVICE_SECRETS", "1");

    const key = getOrCreateGatewayWrappingKey("local");
    expect(readFileSync(mocked.secretsFile, "utf8")).toMatch(
      /^CENTRAID-DEVICE-SECRETS-V1\n/u
    );
    expect(statSync(mocked.secretsFile).mode & 0o777).toBe(0o600);

    const write = vi.spyOn(fs, "writeFileSync");
    expect(getOrCreateGatewayWrappingKey("local")).toStrictEqual(key);
    expect(write).not.toHaveBeenCalled();

    mocked.secretsFile = path.join(root, "packaged-secrets.bin");
    mocked.isPackaged = true;
    getOrCreateGatewayWrappingKey("local");
    expect(readFileSync(mocked.secretsFile, "utf8")).not.toMatch(
      /^CENTRAID-DEVICE-SECRETS-V1\n/u
    );
  });

  test("device credential parsing rejects unavailable custody and unsupported stores", async () => {
    const root = await tempDir("gateway-secrets-errors-");
    mocked.secretsFile = path.join(root, "connection-secrets.bin");
    writeFileSync(mocked.secretsFile, JSON.stringify({ version: 2 }), {
      mode: 0o600,
    });
    mocked.encryptionAvailable = true;
    expect(() => readLocalLoopbackToken("local")).toThrow(
      /unsupported format/u
    );

    writeFileSync(mocked.secretsFile, "encrypted-device-secrets", {
      mode: 0o600,
    });
    mocked.encryptionAvailable = false;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.spyOn(console, "warn").mockReturnValue(undefined);
    expect(() => readLocalLoopbackToken("local")).toThrow(
      /encrypted.*libsecret is unavailable/u
    );

    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(() => storeLocalLoopbackToken("local", "token")).toThrow(
      /keychain is unavailable/u
    );
  });
});
