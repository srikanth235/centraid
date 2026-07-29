import type { SpawnSyncReturns } from "node:child_process";
import type * as TypeImport_1u70gh7 from "node:child_process";
import { promises as fs, statSync } from "node:fs";
import path from "node:path";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { daemonKeyStore, headlessCredentialFile } from "./key-store.js";

/**
 * The KeyStore reaches for exactly one `spawnSync` overload — utf8-encoded, with
 * an explicit argv array (`systemd-creds decrypt` / `security find-generic-password`).
 * `vi.fn` cannot carry an overload set, so the mock is typed to that one call
 * shape and cast back to the module's overloaded export at the mock boundary.
 */
type SpawnSyncUtf8 = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf8" }
) => SpawnSyncReturns<string>;

const mocked = vi.hoisted(() => ({
  spawnSync: vi.fn<SpawnSyncUtf8>(),
}));

vi.mock(import("node:child_process"), () => ({
  spawnSync: mocked.spawnSync as unknown as typeof TypeImport_1u70gh7.spawnSync,
}));

/** A complete `SpawnSyncReturns<string>` so the mock answers exactly what the real call would. */
function spawnResult(over: {
  status: number;
  stdout?: string;
  stderr?: string;
}): SpawnSyncReturns<string> {
  const stdout = over.stdout ?? "";
  const stderr = over.stderr ?? "";
  return {
    pid: 4242,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: over.status,
    signal: null,
  };
}

const roots: string[] = [];

describe("key-store", () => {
  beforeEach(() => {
    mocked.spawnSync.mockReset();
    mocked.spawnSync.mockReturnValue(
      spawnResult({ status: 1, stderr: "not found", stdout: "" })
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await forEachSequentially(roots.splice(0).toReversed(), (root) =>
      fs.rm(root, { recursive: true, force: true })
    );
  });

  test("headless fallback wraps every data-dir key with an external 0600 credential", async () => {
    const root = await tempDir("headless-keystore-");
    const credentialRoot = await tempDir("headless-credentials-");
    roots.push(root, credentialRoot);
    const keysDir = path.join(root, "keys");
    const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };
    const warnings: string[] = [];
    const store = daemonKeyStore(keysDir, {
      env,
      warn: (message) => warnings.push(message),
    });
    const secrets = [
      ["endpoint-key.bin", Buffer.alloc(32, 0x11)],
      ["vault-a.sealkey", Buffer.alloc(32, 0x22)],
      ["connections.sealkey", Buffer.alloc(32, 0x33)],
      ["keyring.key", Buffer.alloc(32, 0x44)],
    ] as const;
    for (const [name, secret] of secrets) store.store(name, secret);

    const credential = headlessCredentialFile(keysDir, env);
    expect(credential.startsWith(`${root}${path.sep}`)).toBe(false);
    expect(statSync(credential).mode & 0o777).toBe(0o600);
    expect(warnings).toContainEqual(
      expect.stringMatching(/external 0600 host credential/iu)
    );
    await forEachSequentially(secrets, async ([name, secret]) => {
      const raw = await fs.readFile(path.join(keysDir, name), "utf8");
      expect(raw).toContain('"scheme":"aes-256-gcm-v1"');
      const payload = JSON.parse(raw.slice(raw.indexOf("{"))) as {
        payload: string;
      };
      expect(Buffer.from(payload.payload, "base64")).not.toStrictEqual(secret);
      expect(store.load(name)).toStrictEqual(secret);
    });
  });

  test("copying only the data dir cannot open headless sealed envelopes", async () => {
    const source = await tempDir("headless-source-");
    const copied = await tempDir("headless-copy-");
    const credentialRoot = await tempDir("headless-copy-credentials-");
    roots.push(source, copied, credentialRoot);
    const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };
    const original = daemonKeyStore(path.join(source, "keys"), { env });
    original.store("endpoint-key.bin", Buffer.alloc(32, 0x5a));
    await fs.cp(source, copied, { recursive: true });

    expect(() =>
      daemonKeyStore(path.join(copied, "keys"), { env }).load(
        "endpoint-key.bin"
      )
    ).toThrow(/authentication failed/iu);
  });

  test("explicit environment and service-manager credentials wrap the key store", async () => {
    const root = await tempDir("headless-explicit-credentials-");
    const credentialsDir = await tempDir("headless-systemd-credentials-");
    roots.push(root, credentialsDir);
    const secret = Buffer.alloc(32, 0x61);
    const wrappingKey = Buffer.alloc(32, 0x62).toString("base64");

    const direct = daemonKeyStore(path.join(root, "direct"), {
      env: { CENTRAID_KEYSTORE_MASTER_KEY: wrappingKey },
    });
    direct.store("secret.bin", secret);
    expect(direct.load("secret.bin")).toStrictEqual(secret);

    await fs.writeFile(
      path.join(credentialsDir, "centraid-keystore"),
      `${wrappingKey}\n`
    );
    const credentialDirectoryStore = daemonKeyStore(
      path.join(root, "credential-directory"),
      {
        env: { CREDENTIALS_DIRECTORY: credentialsDir },
      }
    );
    credentialDirectoryStore.store("secret.bin", secret);
    expect(credentialDirectoryStore.load("secret.bin")).toStrictEqual(secret);

    const encryptedCredential = path.join(root, "centraid-keystore.cred");
    await fs.writeFile(encryptedCredential, "encrypted");
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mocked.spawnSync.mockReturnValue(
      spawnResult({ status: 0, stdout: `${wrappingKey}\n` })
    );
    const systemdStore = daemonKeyStore(path.join(root, "systemd"), {
      env: { CENTRAID_KEYSTORE_CREDENTIAL_ENCRYPTED: encryptedCredential },
    });
    systemdStore.store("secret.bin", secret);
    expect(systemdStore.load("secret.bin")).toStrictEqual(secret);
    expect(mocked.spawnSync).toHaveBeenCalledWith(
      "systemd-creds",
      ["decrypt", "--user", encryptedCredential, "-"],
      { encoding: "utf8" }
    );
  });

  test("credential loading reports platform failures and malformed wrapping keys", async () => {
    const root = await tempDir("headless-credential-errors-");
    roots.push(root);
    const encryptedCredential = path.join(root, "centraid-keystore.cred");
    await fs.writeFile(encryptedCredential, "encrypted");

    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    mocked.spawnSync.mockReturnValue(
      spawnResult({ status: 1, stderr: "decrypt failed" })
    );
    expect(() =>
      daemonKeyStore(path.join(root, "systemd"), {
        env: { CENTRAID_KEYSTORE_CREDENTIAL_ENCRYPTED: encryptedCredential },
      })
    ).toThrow(/decrypt failed/u);

    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    mocked.spawnSync.mockReturnValue(
      spawnResult({ status: 1, stderr: "keychain locked" })
    );
    expect(() =>
      daemonKeyStore(path.join(root, "keychain"), {
        env: { CENTRAID_KEYSTORE_KEYCHAIN_SERVICE: "test.service" },
      })
    ).toThrow(/keychain locked/u);

    expect(() =>
      daemonKeyStore(path.join(root, "bad-master"), {
        env: {
          CENTRAID_KEYSTORE_MASTER_KEY: Buffer.alloc(4).toString("base64"),
        },
      })
    ).toThrow(/one base64-encoded 32-byte key/u);
  });

  test("fallback credentials enforce 0600 mode and reject malformed key material", async () => {
    const root = await tempDir("headless-fallback-validation-");
    const credentialRoot = await tempDir(
      "headless-fallback-validation-credentials-"
    );
    roots.push(root, credentialRoot);
    const keysDir = path.join(root, "keys");
    const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };
    const credentialFile = headlessCredentialFile(keysDir, env);
    await fs.mkdir(path.dirname(credentialFile), { recursive: true });
    await fs.writeFile(
      credentialFile,
      `${Buffer.alloc(32, 3).toString("base64")}\n`,
      {
        mode: 0o644,
      }
    );
    const store = daemonKeyStore(keysDir, { env });
    store.store("secret.bin", Buffer.alloc(32, 4));
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600);

    await fs.writeFile(credentialFile, "not-a-32-byte-key\n");
    expect(() => store.store("another.bin", Buffer.alloc(32, 5))).toThrow(
      /not a base64-encoded 32-byte key/u
    );
  });
});
