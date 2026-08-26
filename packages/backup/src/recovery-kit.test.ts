import crypto from "node:crypto";
/*
 * The recovery-kit READER (#439) — the counterpart to
 * `wrapRecoveryKit`. A kit is the ONLY thing standing between a blank machine
 * and a vault, so the parser is strict: a wrong kind, an unsupported version, a
 * malformed keyring, or a target missing its addressing is refused HERE, not
 * three phases into a restore. These pin exactly that.
 *
 * There is no unwrapped acceptance path (#568), so the document validator is
 * reached through `wrapRecoveryKit` (which validates before sealing) and
 * through a successful unwrap.
 */
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import {
  createKeyring,
  parseRecoveryKit,
  recoveryKitFingerprint,
  wrapRecoveryKit,
} from "./index.js";

async function tempFile(name: string): Promise<string> {
  const dir = await tempDir(`recovery-kit-${crypto.randomUUID()}-`);
  return path.join(dir, name);
}

describe("recovery-kit", () => {
  test("round-trips a wrapped kit", async () => {
    const keyring = await createKeyring(await tempFile("keyring.json"));
    const targets = [
      {
        provider: "https://home.example",
        targetId: "t-1",
        vaultId: "v-1",
        label: "ab12",
      },
    ];
    const wrapped = wrapRecoveryKit(
      {
        version: 1,
        kind: "centraid-recovery-kit",
        createdAt: new Date(0).toISOString(),
        keyring,
        targets,
      },
      "correct horse battery staple"
    );

    const doc = parseRecoveryKit(wrapped, "correct horse battery staple");
    expect(doc.kind).toBe("centraid-recovery-kit");
    expect(doc.version).toBe(1);
    expect(doc.keyring.epochs.length).toBeGreaterThan(0);
    expect(doc.targets).toStrictEqual(targets);
  });

  /*
   * An unwrapped-document branch silently ignores the password, so
   * `vaults:restore`, `vaults:initialize/verify` and the kit-confirmed
   * transition would each gain a password-free acceptance path — passable by
   * anyone holding the plaintext kit file (#568).
   */
  test("refuses an unwrapped kit even with the right shape and a password", async () => {
    const keyring = await createKeyring(await tempFile("keyring.json"));
    const plain = {
      version: 1,
      kind: "centraid-recovery-kit",
      createdAt: new Date(0).toISOString(),
      keyring,
      targets: [
        {
          provider: "https://home.example",
          targetId: "t-1",
          vaultId: "v-1",
          label: "ab12",
        },
      ],
    };
    expect(() =>
      parseRecoveryKit(plain, "correct horse battery staple")
    ).toThrow(/password-wrapped kit/u);
    expect(() => parseRecoveryKit(plain, "")).toThrow(/password-wrapped kit/u);
  });

  test("a wrapped kit still requires a non-empty password", async () => {
    const keyring = await createKeyring(await tempFile("keyring.json"));
    const wrapped = wrapRecoveryKit(
      {
        version: 1,
        kind: "centraid-recovery-kit",
        createdAt: new Date(0).toISOString(),
        keyring,
        targets: [
          {
            provider: "https://home.example",
            targetId: "t-1",
            vaultId: "v-1",
            label: "ab12",
          },
        ],
      },
      "correct horse battery staple"
    );
    expect(() => parseRecoveryKit(wrapped, "")).toThrow(
      /password is required/u
    );
  });

  test("password wrap round-trips keyring + per-target seal key and rejects a wrong password", async () => {
    const keyring = await createKeyring(await tempFile("keyring.json"));
    const plain = {
      version: 1 as const,
      kind: "centraid-recovery-kit" as const,
      createdAt: new Date(0).toISOString(),
      keyring,
      targets: [
        {
          provider: "https://home.example",
          targetId: "t-1",
          vaultId: "v-1",
          label: "cosmetic label",
          sealKey: Buffer.alloc(32, 9).toString("base64"),
        },
      ],
    };
    const wrapped = wrapRecoveryKit(plain, "correct horse battery staple");

    expect(wrapped).toMatchObject({ kdf: "scrypt", N: 2 ** 17, r: 8, p: 1 });
    expect(JSON.stringify(wrapped)).not.toContain(keyring.epochs[0]!.key);
    expect(
      parseRecoveryKit(wrapped, "correct horse battery staple")
    ).toStrictEqual(plain);
    expect(() => parseRecoveryKit(wrapped, "wrong")).toThrow(
      /wrong password or corrupt/u
    );
  });

  test("fingerprint ignores labels and createdAt but changes with recovery material", async () => {
    const keyring = await createKeyring(await tempFile("keyring.json"));
    const base = {
      version: 1 as const,
      kind: "centraid-recovery-kit" as const,
      createdAt: "one",
      keyring,
      targets: [
        {
          provider: "https://home.example",
          targetId: "t-1",
          vaultId: "v-1",
          label: "first",
          sealKey: Buffer.alloc(32, 1).toString("base64"),
        },
      ],
    };
    expect(
      recoveryKitFingerprint({
        ...base,
        createdAt: "two",
        targets: [{ ...base.targets[0]!, label: "renamed" }],
      })
    ).toBe(recoveryKitFingerprint(base));
    expect(
      recoveryKitFingerprint({
        ...base,
        targets: [
          {
            ...base.targets[0]!,
            sealKey: Buffer.alloc(32, 2).toString("base64"),
          },
        ],
      })
    ).not.toBe(recoveryKitFingerprint(base));
  });

  // The document validator runs on the way IN to a wrapped kit (and again on
  // the decrypted plaintext), so `wrapRecoveryKit` is where these refusals are
  // observable from outside the module.
  const wrap =
    (document: unknown): (() => unknown) =>
    () =>
      wrapRecoveryKit(document as never, "correct horse battery staple");

  test("rejects a document that is not a centraid recovery kit", () => {
    expect(wrap({ kind: "something-else", version: 1 })).toThrow(
      /not a centraid-recovery-kit/u
    );
    expect(wrap(null)).toThrow(/not an object/u);
  });

  test("rejects an unsupported version", async () => {
    const keyring = await createKeyring(await tempFile("k.json"));
    expect(
      wrap({
        kind: "centraid-recovery-kit",
        version: 2,
        keyring,
        targets: [{ provider: "x", targetId: "t", vaultId: "v", label: "l" }],
      })
    ).toThrow(/unsupported version/u);
  });

  test("rejects a malformed keyring with the same rules loadKeyring uses", () => {
    expect(
      wrap({
        kind: "centraid-recovery-kit",
        version: 1,
        keyring: { version: 1, active: 1, epochs: [] },
        targets: [{ provider: "x", targetId: "t", vaultId: "v", label: "l" }],
      })
    ).toThrow(/keyring/u);
  });

  test("rejects a target missing its addressing", async () => {
    const keyring = await createKeyring(await tempFile("k.json"));
    expect(
      wrap({
        kind: "centraid-recovery-kit",
        version: 1,
        keyring,
        targets: [{ provider: "x", vaultId: "v", label: "l" }],
      })
    ).toThrow(/missing "targetId"/u);
  });
});
