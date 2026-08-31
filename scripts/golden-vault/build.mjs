#!/usr/bin/env node
/**
 * Freeze a populated vault as a golden corpus (#892 Phase 2).
 *
 * Run this ONCE PER RELEASE, from the release's own tree:
 *
 *   bun run golden-vault:freeze -- --label v0.4.0
 *
 * It founds a vault with the code in the tree it is run from, writes a
 * deterministic corpus through the vault's own API, and freezes the result under
 * `packages/vault/tests/golden/<label>/`. Every PR after that opens the frozen
 * pair with today's code, lets the migration ladder run, and checks the corpus
 * survived (`packages/vault/src/golden-vault.test.ts`).
 *
 * DETERMINISM IS THE WHOLE JOB. A corpus seeded with `Date.now()` and random
 * uuids re-freezes differently every run, so its diff is unreadable and nobody
 * can tell a re-freeze from a rewrite. Every id and timestamp below is derived
 * from a fixed seed, which is also why the frozen `.db` files are stable enough
 * to live in git.
 *
 * WHAT IT DOES NOT DO: it does not fabricate a PREVIOUS release. A golden vault
 * is only prior-release evidence if it was frozen BY that release, so the corpus
 * committed today is the v-current baseline and starts paying the moment the
 * next migration lands. Freezing one per release is the discipline; this script
 * is only the mechanism.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

const root = path.resolve(import.meta.dirname, "../..");
const GOLDEN_ROOT = path.join(root, "packages/vault/tests/golden");

/** A stable id generator: the same label always produces the same corpus. */
function seededIds(seed) {
  let counter = 0;
  return () => {
    counter += 1;
    const digest = createHash("sha256")
      .update(`${seed}:${counter}`)
      .digest("hex");
    // uuidv7-shaped so anything validating the format is satisfied, but wholly
    // derived: no clock, no randomness.
    return [
      digest.slice(0, 8),
      digest.slice(8, 12),
      `7${digest.slice(13, 16)}`,
      `8${digest.slice(17, 20)}`,
      digest.slice(20, 32),
    ].join("-");
  };
}

const FROZEN_NOW = "2026-01-01T00:00:00.000Z";

/**
 * Write the corpus. Deliberately narrow and deliberately CORE: the tables a
 * migration is most likely to touch and a member would most miss — identity,
 * the concept vocabulary, documents, notes, links between them, and the
 * consent journal. A broader corpus is not a better gate; a corpus nobody can
 * read the diff of is a worse one.
 */
async function seedCorpus(db, nextId) {
  const { bootstrapVault } = await import(
    path.join(root, "packages/vault/dist/index.js")
  );
  const bootstrap = bootstrapVault(db, {
    vaultName: "Golden",
    ownerName: "Golden Owner",
  });

  // A document's identity is separate from its bytes (#352), so every corpus
  // row is a content item plus the wrapper that addresses it — the same pair the
  // product writes, which is what makes a migration over this corpus mean
  // anything about a member's vault.
  const contentFor = (label, index) => {
    const contentId = nextId();
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, creator_party_id, created_at)
         VALUES (?, 'text/markdown', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        contentId,
        `inline:golden-${label}-${index}`,
        createHash("sha256").update(`${label}:${index}`).digest("hex"),
        64,
        `Golden ${label} ${index}`,
        bootstrap.ownerPartyId,
        FROZEN_NOW
      );
    return contentId;
  };

  const documentIds = [];
  for (let index = 0; index < 3; index += 1) {
    const documentId = nextId();
    documentIds.push(documentId);
    db.vault
      .prepare(
        `INSERT INTO core_document (document_id, title, current_content_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        documentId,
        `Golden document ${index}`,
        contentFor("document", index),
        FROZEN_NOW,
        FROZEN_NOW
      );
  }

  const noteIds = [];
  for (let index = 0; index < 2; index += 1) {
    const noteId = nextId();
    noteIds.push(noteId);
    db.vault
      .prepare(
        `INSERT INTO knowledge_note
           (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'markdown', 0, ?, ?)`
      )
      .run(
        noteId,
        bootstrap.ownerPartyId,
        `Golden note ${index}`,
        contentFor("note", index),
        FROZEN_NOW,
        FROZEN_NOW
      );
  }

  // A polymorphic link between two corpus rows: the exact shape `vault doctor`
  // sweeps, so the golden gate also proves a migration did not orphan one.
  db.vault
    .prepare(
      `INSERT INTO core_link
         (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, asserted_by)
       VALUES (?, 'knowledge.note', ?, 'core.document', ?, ?, ?, 'owner')`
    )
    .run(
      nextId(),
      noteIds[0],
      documentIds[0],
      bootstrap.concepts["same-as"],
      FROZEN_NOW
    );

  return { bootstrap, documentIds, noteIds };
}

function parseArgs(argv) {
  const out = { label: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--label" && argv[i + 1]) out.label = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.label || !/^[A-Za-z0-9._-]+$/u.test(args.label)) {
    console.error(
      "golden-vault: --label <name> is required (e.g. --label v0.4.0)"
    );
    process.exitCode = 2;
    return;
  }

  // The snapshot format is the vault package's, not this script's: the freezer
  // and the checker must never hold two copies of the comparison rule.
  const { openVaultDb, ONTOLOGY_VERSION, snapshotVault } = await import(
    path.join(root, "packages/vault/dist/index.js")
  );

  const work = mkdtempSync(path.join(tmpdir(), "centraid-golden-"));
  const db = openVaultDb({ dir: work, synchronous: "FULL" });
  let manifest;
  try {
    await seedCorpus(db, seededIds(args.label));
    const userVersion = db.vault.prepare("PRAGMA user_version").get();
    // Fold the WAL into the main file, or the frozen `.db` would be missing the
    // corpus that is still sitting in `-wal` (this vault opens with
    // `wal_autocheckpoint = 0` on purpose, for the WAL shipper).
    db.vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.journal.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // A freshly migrated vault is mostly EMPTY PAGES — the full schema plus the
    // FTS tables allocate ~5.6 MB for ~185 rows of corpus, which is both over
    // the 5 MB `repo-hygiene` tracked-file limit and a wildly misleading diff.
    // VACUUM rewrites the file at its actual occupancy. It is safe to run here
    // and only here: this is a vault nothing else has open.
    db.vault.exec("VACUUM");
    db.journal.exec("VACUUM");
    manifest = {
      label: args.label,
      frozenAt: FROZEN_NOW,
      ontologyVersion: ONTOLOGY_VERSION,
      userVersion: userVersion.user_version,
      tables: snapshotVault(db.vault),
    };
  } finally {
    db.close();
  }

  const dest = path.join(GOLDEN_ROOT, args.label);
  rmSync(dest, { force: true, recursive: true });
  mkdirSync(dest, { recursive: true });
  // GZIPPED, and not as an optimization. A freshly migrated vault.db is ~5.6 MB
  // of mostly empty pages (the full schema plus the FTS shadow tables) for ~185
  // rows of corpus — over `repo-hygiene`'s 5 MB tracked-file limit, and VACUUM
  // does not help because the size is the SCHEMA, not the data. It compresses to
  // ~100 KB. `packages/vault/src/golden-vault.test.ts` inflates into a temp dir
  // before opening, which it would have to do anyway: opening the frozen file in
  // place would let a migration rewrite the corpus it is meant to be checking.
  for (const file of ["vault.db", "journal.db"]) {
    writeFileSync(
      path.join(dest, `${file}.gz`),
      gzipSync(readFileSync(path.join(work, file)), { level: 9 })
    );
  }
  writeFileSync(
    path.join(dest, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  rmSync(work, { force: true, recursive: true });

  const tables = Object.keys(manifest.tables).length;
  const rows = Object.values(manifest.tables).reduce(
    (sum, table) => sum + table.rows,
    0
  );
  console.log(
    `golden-vault: froze ${args.label} — ${tables} table(s), ${rows} row(s), schema v${manifest.userVersion} (ontology ${manifest.ontologyVersion})`
  );
}

await main();
