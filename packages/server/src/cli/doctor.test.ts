import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultRegistry } from "../serve/vault-registry.js";
import { commandDoctor } from "./doctor.js";
import { daemonKeyStore } from "./key-store.js";
import { daemonLayoutFor } from "./paths.js";

const quiet = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function dataDirWithVault(): { dataDir: string; vaultId: string; sha: string } {
  const dataDir = tempDirSync("doctor-cli-");
  const layout = daemonLayoutFor(dataDir);
  const registry = openVaultRegistry({
    keyStore: daemonKeyStore(layout.keysDir),
    rootDir: layout.vaultDir,
    logger: quiet,
    enableWalShipper: false,
  });
  try {
    const created = registry.create("Doctor test vault");
    const plane = registry.get(created.vaultId)!;
    const sha = plane.db.blobs.ingestSync(
      Buffer.from("cli-doctor-blob")
    ).sha256;
    return { dataDir, vaultId: created.vaultId, sha };
  } finally {
    registry.stop();
  }
}

function casFile(dataDir: string, vaultId: string, sha: string): string {
  return path.join(
    daemonLayoutFor(dataDir).vaultDir,
    vaultId,
    "blobs",
    "sha256",
    sha.slice(0, 2),
    sha
  );
}

async function runDoctor(
  args: string[]
): Promise<{ out: string; code: number }> {
  const chunks: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = 0;
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
      );
      return true;
    });
  const fail = (message: string, code = 1): never => {
    throw new Error(`fail(${code}): ${message}`);
  };
  try {
    await commandDoctor(args, fail);
  } finally {
    spy.mockRestore();
  }
  const code = process.exitCode ?? 0;
  process.exitCode = originalExitCode;
  return { out: chunks.join(""), code };
}

describe("doctor CLI verb", () => {
  const cleanup: (() => void)[] = [];
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!();
  });

  test("reports a clean gateway and exits zero (--json)", async () => {
    const { dataDir } = dataDirWithVault();
    const { out, code } = await runDoctor([
      "--data-dir",
      dataDir,
      "--json",
      "--full",
    ]);
    const parsed = JSON.parse(out) as {
      ok: boolean;
      findings: { level: string }[];
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.findings.some((f) => f.level === "error")).toBe(false);
    expect(code).toBe(0);
  });

  test("flips a CAS byte and exits nonzero with a failing finding", async () => {
    const { dataDir, vaultId, sha } = dataDirWithVault();
    const file = casFile(dataDir, vaultId, sha);
    const bytes = readFileSync(file);
    bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
    writeFileSync(file, bytes);
    const { out, code } = await runDoctor([
      "--data-dir",
      dataDir,
      "--json",
      "--full",
    ]);
    const parsed = JSON.parse(out) as {
      ok: boolean;
      findings: { check: string; level: string }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.findings.find((f) => f.check === "cas-rehash")?.level).toBe(
      "error"
    );
    expect(code).toBe(1);
  });

  test("prints human lines when not --json", async () => {
    const { dataDir } = dataDirWithVault();
    const { out } = await runDoctor(["--data-dir", dataDir]);
    expect(out).toContain("database-integrity");
    expect(out).toContain("vault(s) scrubbed");
  });
});
