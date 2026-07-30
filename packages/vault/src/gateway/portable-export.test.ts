import { beforeEach, describe, expect, test } from "vitest";

import { blobUriFor } from "../blob/store.js";
import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import { readZipEntries, writeZipEntries } from "../ingest/zip.js";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import {
  exportIcs,
  exportMarkdownDirectory,
  exportTransactionsCsv,
  exportVcards,
  verifyPortableVault,
} from "./portable-export.js";
import type { Credential } from "./types.js";

let db: VaultDb;
let gateway: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("portable export", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gateway = createGateway(db);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function seedAdapters(): void {
    const now = "2026-07-29T12:00:00.000Z";
    db.vault
      .prepare(
        `INSERT INTO core_event
           (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule,
            status, location_place_id, organizer_party_id, sequence, created_at, updated_at)
         VALUES (?, 'event@example.test', 'Café 東京', 'Agenda', '2026-08-01T09:00:00Z',
                 '2026-08-01T10:00:00Z', 'Asia/Kolkata', NULL, 'confirmed',
                 NULL, NULL, 0, ?, ?)`
      )
      .run(uuidv7(), now, now);
    db.vault
      .prepare(
        `INSERT INTO core_party_identifier
           (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
         VALUES (?, ?, 'email', 'priya@example.test', 'home', 1, NULL, ?, NULL)`
      )
      .run(uuidv7(), boot.ownerPartyId, now);
    const accountId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_account
           (account_id, owner_party_id, name, kind, currency, institution_party_id,
            external_ref, is_asset, opened_at, closed_at)
         VALUES (?, ?, 'Wallet', 'wallet', 'INR', NULL, NULL, 1, NULL, NULL)`
      )
      .run(accountId, boot.ownerPartyId);
    db.vault
      .prepare(
        `INSERT INTO core_transaction
           (txn_id, account_id, posted_at, amount_minor, currency, direction, status,
            transfer_group_id, counterparty_party_id, description, category_concept_id, external_id)
         VALUES (?, ?, '2026-07-28T00:00:00Z', 4250, 'INR', 'debit', 'posted',
                 NULL, NULL, 'Tea', NULL, 'txn-1')`
      )
      .run(uuidv7(), accountId);
    const body = "# Café\n\nRésumé 東京";
    const contentId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language,
            creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, 'text/markdown', ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`
      )
      .run(
        contentId,
        `data:text/markdown;charset=utf-8,${encodeURIComponent(body)}`,
        "a".repeat(64),
        Buffer.byteLength(body),
        boot.ownerPartyId,
        now
      );
    db.vault
      .prepare(
        `INSERT INTO knowledge_note
           (note_id, author_party_id, title, body_content_id, format, pinned,
            created_at, updated_at, deleted_at, purge_at)
         VALUES (?, ?, 'Café 東京', ?, 'markdown', 0, ?, ?, NULL, NULL)`
      )
      .run(uuidv7(), boot.ownerPartyId, contentId, now, now);
  }

  test("ICS, vCard, CSV, and Markdown adapters re-enter through one staged batch", () => {
    seedAdapters();
    const archive = writeZipEntries([
      { name: "calendar.ics", data: Buffer.from(exportIcs(db)) },
      { name: "contacts.vcf", data: Buffer.from(exportVcards(db)) },
      {
        name: "transactions.csv",
        data: Buffer.from(exportTransactionsCsv(db)),
      },
      ...exportMarkdownDirectory(db).map((entry) => ({
        ...entry,
        name: entry.name.replace(/^adapters\/markdown\//u, ""),
      })),
    ]);
    const fresh = openVaultDb();
    const freshBoot = bootstrapVault(fresh, { ownerName: "New owner" });
    const freshGateway = createGateway(fresh);
    const staged = freshGateway.stageImportFile(
      {
        kind: "device",
        deviceId: freshBoot.deviceId,
        deviceKey: freshBoot.deviceKey,
      },
      { filename: "portable-adapters.zip", data: archive }
    );
    expect(staged.total).toBeGreaterThanOrEqual(4);
    expect(staged.unrouted).toStrictEqual([]);
    freshGateway.publishImport(
      {
        kind: "device",
        deviceId: freshBoot.deviceId,
        deviceKey: freshBoot.deviceKey,
      },
      staged.batchId
    );
    expect(
      (
        fresh.vault.prepare("SELECT count(*) AS n FROM core_event").get() as {
          n: number;
        }
      ).n
    ).toBe(1);
    expect(
      (
        fresh.vault
          .prepare("SELECT count(*) AS n FROM core_transaction")
          .get() as { n: number }
      ).n
    ).toBe(1);
    expect(
      fresh.vault
        .prepare("SELECT title FROM knowledge_note")
        .all()
        .map((row) => row.title)
    ).toContain("Café 東京");
    fresh.close();
  });

  test("full bundle hashes every canonical file and CAS byte on a clean machine", async () => {
    seedAdapters();
    const binary = Buffer.from("document bytes from another device");
    const stored = db.blobs.ingestSync(binary);
    const contentId = uuidv7();
    const now = "2026-07-29T12:00:00.000Z";
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language,
            creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, 'application/pdf', ?, ?, ?, 'Contract.pdf', NULL, ?, NULL, NULL, NULL, ?)`
      )
      .run(
        contentId,
        blobUriFor(stored.sha256),
        stored.sha256,
        stored.byteSize,
        boot.ownerPartyId,
        now
      );
    db.vault
      .prepare(
        `INSERT INTO core_document
           (document_id, title, current_content_id, created_at, updated_at, deleted_at, purge_at)
         VALUES (?, 'Contract', ?, ?, ?, NULL, NULL)`
      )
      .run(uuidv7(), contentId, now, now);

    const exported = await gateway.exportPortableVault(owner);
    const cleanMachineManifest = verifyPortableVault(exported.bytes);
    expect(cleanMachineManifest.includes).toContain("documents-and-versions");
    expect(cleanMachineManifest.includes).toContain("folders");
    expect(cleanMachineManifest.includes).toContain("tags");
    const entries = new Map(
      readZipEntries(exported.bytes).map((entry) => [entry.name, entry.data])
    );
    expect(entries.get(`content/${stored.sha256}`)).toStrictEqual(binary);
    expect(entries.has("canonical/vault.json")).toBe(true);
    expect(entries.has("adapters/calendar.ics")).toBe(true);

    const tampered = Buffer.from(exported.bytes);
    const marker = tampered.indexOf(binary);
    expect(marker).toBeGreaterThan(0);
    tampered[marker]! ^= 0xff;
    expect(() => verifyPortableVault(tampered)).toThrow(/integrity failure/u);
  });
});
