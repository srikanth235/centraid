/*
 * The two-vault world every grant-fulfillment test runs in: Priya's vault as
 * the origin, Ravi's as the audience, both mounted on ONE host, one shared
 * document. Shared so a test file stays inside its line budget rather than a
 * second copy of the seeding drifting away from the first.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";
import {
  beginReplicaCommit,
  blobUriFor,
  bootstrapVault,
  createShareGrant,
  endReplicaCommit,
  nowIso,
  openVaultDb,
  uuidv7,
} from "@centraid/vault";
import type { BootstrapResult, VaultDb } from "@centraid/vault";

export const ORIGIN_VAULT = "vlt_priya";
export const AUDIENCE_VAULT = "vlt_ravi";

export interface Side {
  vault: VaultDb;
  boot: BootstrapResult;
}

/** Every vault a test opened, closed by the caller's `afterEach`. */
export const open: VaultDb[] = [];

export function closeOpenVaults(): void {
  while (open.length > 0) open.pop()?.close();
}

/**
 * An origin edit AS THE GATEWAY MAKES ONE — inside a captured replica commit.
 * The `update` half of the three outputs is the LOG's (#996, R10), so an edit
 * written behind the log is one no subscription can see; that is a property of
 * the transport, and a test that edits outside a commit is testing a write the
 * product cannot produce.
 */
export function inCommit(db: VaultDb, body: () => void): void {
  db.vault.exec("BEGIN IMMEDIATE");
  const handle = beginReplicaCommit(db.vault);
  try {
    body();
    endReplicaCommit(db.vault, handle);
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
}

export function makeVault(root: string, name: string, vaultId: string): Side {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const vault = openVaultDb({ dir });
  open.push(vault);
  return { vault, boot: bootstrapVault(vault, { ownerName: name, vaultId }) };
}

export function seedDocument(side: Side, title: string, body: string): string {
  const now = nowIso();
  const blob = side.vault.blobs.ingestSync(Buffer.from(body));
  const contentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, content_uri, sha256, byte_size, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?)`
    )
    .run(
      contentId,
      blobUriFor(blob.sha256),
      blob.sha256,
      blob.byteSize,
      side.boot.ownerPartyId,
      side.boot.deviceId,
      now
    );
  const documentId = uuidv7();
  side.vault.vault
    .prepare(
      `INSERT INTO core_document
         (document_id, title, current_content_id, created_at, updated_at,
          deleted_at, purge_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`
    )
    .run(documentId, title, contentId, now, now);
  return documentId;
}

export function audienceTitles(side: Side): string[] {
  return (
    side.vault.vault
      .prepare("SELECT title FROM core_document ORDER BY title")
      .all() as { title: string }[]
  ).map((row) => row.title);
}

export interface SharedWorld {
  priya: Side;
  ravi: Side;
  raviParty: string;
  documentId: string;
  grantId: string;
  host: { vaultFor: (vaultId: string) => VaultDb | undefined };
  now: string;
}

/** Priya, Ravi, one shared document, this host holding both vaults. */
export function sharedWorld(): SharedWorld {
  const root = tempDirSync("centraid-grant-delivery-");
  const priya = makeVault(root, "priya", ORIGIN_VAULT);
  const ravi = makeVault(root, "ravi", AUDIENCE_VAULT);
  const now = nowIso();
  const raviParty = uuidv7();
  priya.vault.vault
    .prepare(
      `INSERT INTO core_party
         (party_id, kind, display_name, sort_name, created_at, updated_at)
       VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?)`
    )
    .run(raviParty, now, now);
  priya.vault.vault
    .prepare(
      `INSERT INTO share_party_vault_binding
         (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
       VALUES (?, ?, ?, NULL, ?, NULL)`
    )
    .run(uuidv7(), raviParty, AUDIENCE_VAULT, now);
  const documentId = seedDocument(priya, "Trip plan", "day one");
  const mounted = new Map<string, VaultDb>([
    [ORIGIN_VAULT, priya.vault],
    [AUDIENCE_VAULT, ravi.vault],
  ]);
  const grant = createShareGrant(priya.vault.vault, {
    audience: { kind: "party", id: raviParty },
    subjectType: "core.document",
    subjectId: documentId,
    capability: "view",
    grantedAt: now,
    grantedBy: priya.boot.ownerPartyId,
  });
  expect(grant.grantId).toBeTypeOf("string");
  return {
    priya,
    ravi,
    raviParty,
    documentId,
    grantId: grant.grantId,
    host: { vaultFor: (vaultId: string) => mounted.get(vaultId) },
    now,
  };
}
