import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultDb } from "./db.js";
import type { VaultDb } from "./db.js";
import { formatDoctorReport, vaultDoctor } from "./doctor.js";
import { compareSnapshot } from "./golden-snapshot.js";
import type { VaultSnapshot } from "./golden-snapshot.js";

const GOLDEN_ROOT = path.resolve(import.meta.dirname, "../tests/golden");

function schemaOf(db: VaultDb): Map<string, string> {
  const rows = db.vault
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE name NOT LIKE 'sqlite\\_stat%' ESCAPE '\\'
        ORDER BY type, name`
    )
    .all() as { type: string; name: string; sql: string | null }[];
  return new Map(rows.map((row) => [`${row.type} ${row.name}`, row.sql ?? ""]));
}

function goldenLabels(): string[] {
  if (!existsSync(GOLDEN_ROOT)) return [];
  return readdirSync(GOLDEN_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const labels = goldenLabels();

describe("golden vaults", () => {
  it("has at least one frozen corpus to open", () => {
    expect(labels.length).toBeGreaterThan(0);
  });

  describe.each(labels)("%s", (label) => {
    const dir = path.join(GOLDEN_ROOT, label);
    const manifest = JSON.parse(
      readFileSync(path.join(dir, "manifest.json"), "utf8")
    ) as {
      label: string;
      userVersion: number;
      tables: VaultSnapshot;
    };

    const openGolden = () => {
      const work = tempDirSync(`centraid-golden-${label}-`);
      writeFileSync(
        path.join(work, "vault.db"),
        gunzipSync(readFileSync(path.join(dir, "vault.db.gz")))
      );
      return { work, db: openVaultDb({ dir: work }) };
    };

    it("opens under today's code and migrates forward", () => {
      const { work, db } = openGolden();
      try {
        const after = db.vault.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        expect(after.user_version).toBeGreaterThanOrEqual(manifest.userVersion);
      } finally {
        db.close();
        rmSync(work, { force: true, recursive: true });
      }
    });

    it("preserves every row the release froze", () => {
      const { work, db } = openGolden();
      try {
        const result = compareSnapshot(manifest.tables, db.vault);
        expect(result.findings.join("\n")).toBe("");
        expect(result.ok).toBe(true);
        expect(result.compared.rows).toBeGreaterThan(0);
      } finally {
        db.close();
        rmSync(work, { force: true, recursive: true });
      }
    });

    it("carries the schema today's baseline builds", () => {
      const { work, db } = openGolden();
      const freshDir = tempDirSync(`centraid-golden-${label}-baseline-`);
      const fresh = openVaultDb({ dir: freshDir });
      try {
        const frozenSchema = schemaOf(db);
        const freshSchema = schemaOf(fresh);
        const findings = [
          ...[...frozenSchema.keys()]
            .filter((name) => !freshSchema.has(name))
            .map(
              (name) => `${name}: in the frozen corpus, not in the baseline`
            ),
          ...[...freshSchema.keys()]
            .filter((name) => !frozenSchema.has(name))
            .map(
              (name) => `${name}: in the baseline, not in the frozen corpus`
            ),
          ...[...frozenSchema.entries()]
            .filter(
              ([name, sql]) =>
                freshSchema.has(name) && freshSchema.get(name) !== sql
            )
            .map(([name]) => `${name}: frozen DDL differs from the baseline's`),
        ];
        expect(findings.join("\n")).toBe("");
      } finally {
        db.close();
        fresh.close();
        rmSync(work, { force: true, recursive: true });
        rmSync(freshDir, { force: true, recursive: true });
      }
    });

    it("holds together structurally after migrating", () => {
      const { work, db } = openGolden();
      try {
        const report = vaultDoctor(db);
        expect(formatDoctorReport(report)).toContain("clean");
        expect(report.ok).toBe(true);
      } finally {
        db.close();
        rmSync(work, { force: true, recursive: true });
      }
    });
  });
});
