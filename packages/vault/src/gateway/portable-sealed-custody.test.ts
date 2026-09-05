/*
 * Sealed values across the portable export/import boundary (#630, closing
 * review-A 10.1 and review-B BUG-12).
 *
 * The old bundle shipped `custody/seal-key.bin` — the vault's DEK in the clear,
 * inside the same unencrypted zip as the ciphertext it opens — so every locker
 * secret was one `unzip` away, and an artifact-level import copied the SOURCE
 * vault's key fingerprint into the target, which then reported success and
 * refused to reopen. These pin the replacement end to end: ciphertext only, a
 * password-wrapped custody kit, re-sealing under the target's own key, and a
 * refusal that writes nothing.
 */

import { rmSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerLockerCommands } from "../commands/locker.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { readZipEntries, writeZipEntries } from "../ingest/zip.js";
import {
  readSealKeyFingerprint,
  sealKeyFingerprint,
} from "../schema/sealed.js";
import { createGateway } from "./gateway.js";
import type { Gateway } from "./gateway.js";
import { importVaultExport } from "./portability.js";
import { importPortableVault, verifyPortableVault } from "./portable-export.js";
import type { Credential } from "./types.js";

const PASSPHRASE = "correct horse battery staple";
const SECRET = "hunter2-zzyzxsecret";

let root: string;
let sourceDir: string;
let targetDir: string;
let source: VaultDb;
let sourceBoot: BootstrapResult;
let sourceGateway: Gateway;
let owner: Credential;
let target: VaultDb;
let targetBoot: BootstrapResult;

function credentialFor(boot: BootstrapResult): Credential {
  return { kind: "device", deviceId: boot.deviceId, deviceKey: boot.deviceKey };
}

function countOf(db: VaultDb, table: string): number {
  return (
    db.vault.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as {
      n: number;
    }
  ).n;
}

describe("portable export sealed custody", () => {
  beforeEach(() => {
    root = tempDirSync("portable-sealed-");
    sourceDir = path.join(root, "source");
    targetDir = path.join(root, "target");
    // autoClose:false — these tests close and REOPEN both vaults on purpose.
    ({ db: source, boot: sourceBoot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { dir: sourceDir, ownerName: "Priya", autoClose: false }
    ));
    sourceGateway = createGateway(source);
    registerLockerCommands(sourceGateway);
    owner = credentialFor(sourceBoot);
    ({ db: target, boot: targetBoot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { dir: targetDir, ownerName: "Fresh", autoClose: false }
    ));
  });

  afterEach(() => {
    for (const db of [source, target]) {
      try {
        db.close();
      } catch {
        // already closed by a reopen inside the test
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  function addLogin(password = SECRET): string {
    const out = sourceGateway.invoke(owner, {
      command: "locker.add_item",
      input: {
        type: "login",
        title: "example.com",
        username: "priya",
        password,
        url: "https://example.com",
      },
    });
    expect(out.status).toBe("executed");
    return (out as { output: { item_id: string } }).output.item_id;
  }

  test("a passphrased bundle restores secrets under the TARGET's own key", async () => {
    const itemId = addLogin();
    const sourceFingerprint = sealKeyFingerprint(source.sealKey);
    const targetFingerprint = sealKeyFingerprint(target.sealKey);
    expect(targetFingerprint).not.toBe(sourceFingerprint);

    const exported = await sourceGateway.exportPortableVault(owner, {
      passphrase: PASSPHRASE,
    });
    expect(exported.manifest.sealed).toBe("recovery-kit");
    expect(
      exported.manifest.files.find(
        (file) => file.path === "custody/recovery-kit.json"
      )?.kind
    ).toBe("custody");

    importPortableVault(target, exported.bytes, {
      replaceBootstrap: true,
      passphrase: PASSPHRASE,
    });

    // The stamp names the key this vault actually seals with — never the
    // source's, which is the whole of BUG-12.
    expect(readSealKeyFingerprint(target.vault)).toBe(targetFingerprint);
    expect(readSealKeyFingerprint(target.vault)).not.toBe(sourceFingerprint);

    target.close();
    const reopened = openVaultDb({ dir: targetDir });
    target = reopened;
    expect(sealKeyFingerprint(reopened.sealKey)).toBe(targetFingerprint);
    const reopenedGateway = createGateway(reopened);
    registerLockerCommands(reopenedGateway);
    const revealed = reopenedGateway.reveal(credentialFor(sourceBoot), {
      entity: "locker.item",
      entityId: itemId,
      columns: ["password"],
    });
    expect(revealed.values["password"]).toBe(SECRET);
  });

  test("no plaintext secret survives anywhere in the artifact", async () => {
    addLogin();
    const exported = await sourceGateway.exportPortableVault(owner, {
      passphrase: PASSPHRASE,
    });
    // The whole zip, bytes and all: the adapters, the manifest, the kit.
    expect(exported.bytes.indexOf(Buffer.from(SECRET, "utf8"))).toBe(-1);
    // …and the seal key itself never appears in the clear either.
    expect(exported.bytes.indexOf(source.sealKey)).toBe(-1);
    const entries = readZipEntries(exported.bytes);
    expect(entries.some((entry) => entry.name === "custody/seal-key.bin")).toBe(
      false
    );
    const canonical = entries.find(
      (entry) => entry.name === "canonical/vault.json"
    );
    const artifact = JSON.parse(canonical!.data.toString("utf8")) as {
      tables: Record<string, Record<string, unknown>[]>;
    };
    const hits: string[] = [];
    for (const [entity, rows] of Object.entries(artifact.tables)) {
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          if (typeof value === "string" && value.includes(SECRET))
            hits.push(`${entity}.${column}`);
        }
      }
    }
    expect(hits).toStrictEqual([]);
  });

  test("a ciphertext-only bundle is refused, and writes nothing", async () => {
    addLogin();
    const exported = await sourceGateway.exportPortableVault(owner);
    expect(exported.manifest.sealed).toBe("ciphertext-only");
    expect(() => verifyPortableVault(exported.bytes)).not.toThrow();

    const before = {
      parties: countOf(target, "core_party"),
      items: countOf(target, "locker_item"),
    };
    expect(() =>
      importPortableVault(target, exported.bytes, { replaceBootstrap: true })
    ).toThrow(/sealed value/u);
    expect(countOf(target, "core_party")).toBe(before.parties);
    expect(countOf(target, "locker_item")).toBe(before.items);
    expect(readSealKeyFingerprint(target.vault)).toBeNull();
    // The target's own owner is still the owner — no half-applied restore.
    expect(
      (
        target.vault
          .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
          .get(targetBoot.ownerPartyId) as { display_name: string }
      ).display_name
    ).toBe("Fresh");
  });

  test("a kit without its passphrase, and a wrong passphrase, both refuse", async () => {
    addLogin();
    const exported = await sourceGateway.exportPortableVault(owner, {
      passphrase: PASSPHRASE,
    });
    expect(() =>
      importPortableVault(target, exported.bytes, { replaceBootstrap: true })
    ).toThrow(/password-wrapped recovery kit/u);
    expect(() =>
      importPortableVault(target, exported.bytes, {
        replaceBootstrap: true,
        passphrase: "not the passphrase",
      })
    ).toThrow(/wrong password or corrupt file/u);
    expect(countOf(target, "locker_item")).toBe(0);
  });

  test("a bundle carrying a plaintext seal key is refused outright", async () => {
    addLogin();
    const exported = await sourceGateway.exportPortableVault(owner, {
      passphrase: PASSPHRASE,
    });
    const legacy = writeZipEntries([
      ...readZipEntries(exported.bytes),
      { name: "custody/seal-key.bin", data: Buffer.from(source.sealKey) },
    ]);
    expect(() =>
      importPortableVault(target, legacy, {
        replaceBootstrap: true,
        passphrase: PASSPHRASE,
      })
    ).toThrow(/plaintext seal key/u);
    expect(countOf(target, "locker_item")).toBe(0);
  });

  test("the row-level artifact import refuses sealed values with no key", () => {
    addLogin();
    const { artifact } = sourceGateway.exportVault(owner);
    expect(() =>
      importVaultExport(target, artifact, { replaceBootstrap: true })
    ).toThrow(/sealed value/u);
    expect(countOf(target, "locker_item")).toBe(0);
    // With the source key it lands, re-sealed, and the stamp is the target's.
    importVaultExport(target, artifact, {
      replaceBootstrap: true,
      sourceSealKey: source.sealKey,
    });
    expect(countOf(target, "locker_item")).toBe(1);
    expect(readSealKeyFingerprint(target.vault)).toBe(
      sealKeyFingerprint(target.sealKey)
    );
  });
});
