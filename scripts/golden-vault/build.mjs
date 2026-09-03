#!/usr/bin/env node
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

function seededIds(seed) {
  let counter = 0;
  return () => {
    counter += 1;
    const digest = createHash("sha256")
      .update(`${seed}:${counter}`)
      .digest("hex");
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

async function seedCorpus(db, nextId) {
  const { bootstrapVault } = await import(
    path.join(root, "packages/vault/dist/index.js")
  );
  const bootstrap = bootstrapVault(db, {
    vaultName: "Golden",
    ownerName: "Golden Owner",
  });

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

  const { openVaultDb, ONTOLOGY_VERSION, snapshotVault } = await import(
    path.join(root, "packages/vault/dist/index.js")
  );

  const work = mkdtempSync(path.join(tmpdir(), "centraid-golden-"));
  const db = openVaultDb({ dir: work, synchronous: "FULL" });
  let manifest;
  try {
    await seedCorpus(db, seededIds(args.label));
    const userVersion = db.vault.prepare("PRAGMA user_version").get();
    db.vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.vault.exec("VACUUM");
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
  writeFileSync(
    path.join(dest, "vault.db.gz"),
    gzipSync(readFileSync(path.join(work, "vault.db")), { level: 9 })
  );
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
