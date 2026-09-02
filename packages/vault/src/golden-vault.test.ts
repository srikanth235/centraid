// THE GOLDEN-VAULT GATE (#892). `schema/migrate.test.ts` replays the ladder, but
// only over vaults this build just created. Each corpus under `../tests/golden/`
// was FROZEN BY a release; this inflates it (never opening the committed file,
// which a migration would rewrite), opens it — running the ladder — and asks
// whether every row survived with its values, and whether the result still holds
// together structurally (`vault doctor`, for the pointers no FK covers). When a
// release retires a column, re-freeze the corpus in it; never loosen this.

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
// Shared with the freezer script: two copies of the comparison rule is how a
// gate comes to pass against a corpus it no longer describes.
import { compareSnapshot } from "./golden-snapshot.js";
import type { VaultSnapshot } from "./golden-snapshot.js";

const GOLDEN_ROOT = path.resolve(import.meta.dirname, "../tests/golden");

/**
 * Every schema object a vault holds, by name. `sqlite_stat*` is excluded: it is
 * the query planner's own statistics table, written by ANALYZE over the corpus
 * rows, so its presence says how much data a file has and nothing about shape.
 */
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
  // An empty corpus directory is a wiring failure, not a pass: every other
  // assertion is inside the `describe.each`, so it would go vacuously green.
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

    /** Inflate the frozen file into a scratch dir and open it. */
    const openGolden = () => {
      const work = tempDirSync(`centraid-golden-${label}-`);
      writeFileSync(
        path.join(work, "vault.db"),
        gunzipSync(readFileSync(path.join(dir, "vault.db.gz")))
      );
      // `openVaultDb` migrates on open — that IS the upgrade under test.
      return { work, db: openVaultDb({ dir: work }) };
    };

    it("opens under today's code and migrates forward", () => {
      const { work, db } = openGolden();
      try {
        const after = db.vault.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        // Forward-only: today's ladder may advance the frozen vault, never
        // rewind it. A lower version after opening means the file was opened
        // by a build that does not understand it.
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
        // The findings ARE the message: "3 rows present before the upgrade are
        // GONE after it" is what a reviewer needs, not `expected true to be false`.
        expect(result.findings.join("\n")).toBe("");
        expect(result.ok).toBe(true);
        // Prove the comparison had something to compare — a manifest that
        // silently lost its tables would otherwise pass.
        expect(result.compared.rows).toBeGreaterThan(0);
      } finally {
        db.close();
        rmSync(work, { force: true, recursive: true });
      }
    });

    // THE SHAPE, not just the rows (#916, audit F2). The row comparison above
    // is blind to DDL: the corpus was frozen a few commits before the wave's
    // last shape fixes and carried three foreign keys the shipping baseline had
    // dropped, and every gate stayed green. A migration never rewrites a table
    // it did not name, so a frozen file whose schema has drifted from the
    // baseline is testing a vault this build cannot produce.
    //
    // It is a real assertion, not a stored snapshot: the expected side is a
    // vault FOUNDED HERE by the same `openVaultDb`, so there is nothing to
    // rewrite when it fails. The answer to a failure is `bun run
    // golden-vault:freeze -- --label <this one>`, never a looser comparison.
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
