import { existsSync, promises as fs } from "node:fs";
// governance: allow-repo-hygiene file-size-limit one lifecycle sweep, one spec — the purge matrix is a single table of invariants; splitting it scatters the completeness argument
import path from "node:path";

import { afterEach, assert, beforeEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";

import { blobUriFor } from "../blob/store.js";
import { bootstrapVault, createGrant, enrollApp } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { readLiveShareGrant } from "../grant/grant-store.js";
import { uuidv7 } from "../ids.js";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import type { CommandDefinition, Credential } from "./types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("duties", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    gw = createGateway(db);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  let custodyDir: string;
  let fileDb: VaultDb | null = null;

  afterEach(async () => {
    fileDb?.close();
    fileDb = null;
    if (custodyDir) await fs.rm(custodyDir, { recursive: true, force: true });
    custodyDir = "";
  });

  function registerTagCommand(): void {
    const def: CommandDefinition = {
      name: "test.tag_anything",
      ownerSchema: "finance",
      inputSchema: {
        type: "object",
        required: ["target_type", "target_id"],
        properties: {
          target_type: { type: "string" },
          target_id: { type: "string" },
        },
      },
      outputSchema: { type: "object", properties: {} },
      preconditions: [],
      postconditions: [],
      idempotency: "retry-safe",
      risk: "low",
      handler: (ctx) => {
        const input = ctx.input as { target_type: string; target_id: string };
        const tagId = ctx.newId();
        ctx.db
          .prepare(
            `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
           VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            tagId,
            input.target_type,
            input.target_id,
            boot.concepts["anomaly"] as string,
            ctx.now
          );
        ctx.wrote("core.tag", tagId);
        return { tag_id: tagId };
      },
    };
    gw.registerCommand(def);
  }

  test("S4 polymorphic validation: a tag pointing at a dead row rolls the command back", () => {
    registerTagCommand();
    const outcome = gw.invoke(owner, {
      command: "test.tag_anything",
      input: { target_type: "core.transaction", target_id: "no-such-txn" },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toMatch(/FOREIGN KEY/iu);
    const tags = db.vault
      .prepare("SELECT count(*) AS n FROM core_tag")
      .get() as { n: number };
    expect(tags.n).toBe(0);
  });

  test("S4 polymorphic validation: unknown entity name in the type column also rolls back", () => {
    registerTagCommand();
    const outcome = gw.invoke(owner, {
      command: "test.tag_anything",
      input: { target_type: "evil.table", target_id: "x" },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toMatch(/FOREIGN KEY/iu);
  });

  test("S4 polymorphic validation: a live target passes", () => {
    registerTagCommand();
    const outcome = gw.invoke(owner, {
      command: "test.tag_anything",
      input: { target_type: "core.party", target_id: boot.ownerPartyId },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("executed");
  });

  test("S3 version brokering: a command registered against another ontology version is refused", () => {
    registerTagCommand();
    db.vault
      .prepare(
        `UPDATE agent_command SET ontology_version = '0.9' WHERE name = 'test.tag_anything'`
      )
      .run();
    const outcome = gw.invoke(owner, {
      command: "test.tag_anything",
      input: { target_type: "core.party", target_id: boot.ownerPartyId },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.reason).toContain("contract version 0.9 not served");
  });

  test("retention policy: sweep deletes rows past the window using the policy timestamp column", () => {
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO social_thread (thread_id, channel, created_at) VALUES ('th1', 'sms', ?)`
      )
      .run(now);
    const mkContent = (id: string, sha: string) =>
      db.vault
        .prepare(
          `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'text/plain', 'file:///x', ?, 1, ?)`
        )
        .run(id, sha, now);
    mkContent("c1", "sha-old");
    mkContent("c2", "sha-new");
    db.vault
      .prepare(
        `INSERT INTO social_message (message_id, thread_id, sender_handle, sent_at, body_content_id, delivery)
       VALUES ('m-old', 'th1', 'x@y.z', '2020-01-01T00:00:00Z', 'c1', 'read')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO social_message (message_id, thread_id, sender_handle, sent_at, body_content_id, delivery)
       VALUES ('m-new', 'th1', 'x@y.z', ?, 'c2', 'read')`
      )
      .run(now);
    db.vault
      .prepare(
        `INSERT INTO access_policy (policy_id, kind, entity, rule_json, retention_days, effective_from, priority)
       VALUES (?, 'retention', 'social.message', '{"timestamp_column":"sent_at"}', 365, '2020-01-01T00:00:00Z', 1)`
      )
      .run(uuidv7());
    const result = gw.sweep(owner);
    expect(result.retentionDeleted).toBe(1);
    const remaining = db.vault
      .prepare("SELECT message_id FROM social_message")
      .all();
    expect(remaining.map((row) => ({ ...row }))).toStrictEqual([
      { message_id: "m-new" },
    ]);
  });

  test("retention policy on media.asset is refused with a stated reason, never silently skipped", () => {
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('c-ret', 'image/jpeg', 'file:///x', 'sha-ret', 1, '2019-01-01T00:00:00Z')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO media_asset (asset_id, content_id, kind, captured_at)
         VALUES ('a-ret', 'c-ret', 'photo', '2019-01-01T00:00:00Z')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO access_policy (policy_id, kind, entity, rule_json, retention_days, effective_from, priority)
       VALUES (?, 'retention', 'media_asset', '{}', 30, '2020-01-01T00:00:00Z', 1)`
      )
      .run(uuidv7());
    const result = gw.sweep(owner);
    expect(result.retentionDeleted).toBe(0);
    expect(result.retentionRefused).toHaveLength(1);
    expect(result.retentionRefused[0]?.entity).toBe("media.asset");
    expect(result.retentionRefused[0]?.reason).toContain("trash lifecycle");
    const kept = db.vault.prepare("SELECT asset_id FROM media_asset").all();
    expect(kept.map((row) => ({ ...row }))).toStrictEqual([
      { asset_id: "a-ret" },
    ]);
  });

  test("lifecycle sweep purges lapsed trashed notes with their edges (issue #308 A6)", () => {
    const now = new Date().toISOString();
    const past = "2020-01-01T00:00:00Z";
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at, deleted_at, purge_at)
       VALUES ('body-1', 'text/plain', 'data:text/plain,x', 'sha-note-body', 1, ?, ?, ?)`
      )
      .run(past, past, past);
    db.vault
      .prepare(
        `INSERT INTO knowledge_note (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at, deleted_at, purge_at)
       VALUES ('n-lapsed', ?, 'Lapsed', 'body-1', 'plain', 0, ?, ?, ?, ?)`
      )
      .run(boot.ownerPartyId, past, past, past, past);
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('body-2', 'text/plain', 'data:text/plain,y', 'sha-note-body-2', 1, ?)`
      )
      .run(now);
    db.vault
      .prepare(
        `INSERT INTO knowledge_note (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at, deleted_at, purge_at)
       VALUES ('n-fresh', ?, 'Fresh trash', 'body-2', 'plain', 0, ?, ?, ?, '2999-01-01T00:00:00Z')`
      )
      .run(boot.ownerPartyId, now, now, now);
    db.vault
      .prepare(
        `INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id, body_text, created_at)
       VALUES ('a1', ?, 'knowledge.note', 'n-lapsed', 'margin note', ?)`
      )
      .run(boot.ownerPartyId, past);
    const result = gw.sweep(owner);
    expect(result.notesPurged).toBe(1);
    expect(
      db.vault
        .prepare(`SELECT 1 FROM knowledge_note WHERE note_id = 'n-lapsed'`)
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM knowledge_annotation WHERE annotation_id = 'a1'`
        )
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(`SELECT 1 FROM core_content_item WHERE content_id = 'body-1'`)
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(`SELECT 1 FROM knowledge_note WHERE note_id = 'n-fresh'`)
        .get()
    ).toBeTruthy();
  });

  test("a purged subject ENDS its standing answers, dated and receipted (#883)", () => {
    const past = "2020-01-01T00:00:00Z";
    const ravi = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?)`
      )
      .run(ravi, past, past);
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('doc-body', 'text/plain', 'data:text/plain,z', 'sha-doc-body', 1, ?)`
      )
      .run(past);
    db.vault
      .prepare(
        `INSERT INTO core_document (document_id, title, current_content_id, created_at, updated_at, deleted_at, purge_at)
         VALUES ('doc-shared', 'Trip plan', 'doc-body', ?, ?, ?, ?)`
      )
      .run(past, past, past, past);
    const authorityId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO share_authority
           (authority_id, principal_kind, principal_id, subject_type, subject_id,
            verb, duration, expires_at, decision, granted_at, granted_by,
            revoked_at, receipt_id)
         VALUES (?, 'person', ?, 'core.document', 'doc-shared', 'view',
                 'standing', NULL, 'granted', ?, ?, NULL, NULL)`
      )
      .run(authorityId, ravi, past, boot.ownerPartyId);

    const result = gw.sweep(owner);
    expect(result.documentsPurged).toBe(1);
    expect(
      db.vault
        .prepare(
          "SELECT decision, revoked_at FROM share_authority WHERE authority_id = ?"
        )
        .get(authorityId)
    ).toMatchObject({ decision: "granted" });
    const revokedAt = (
      db.vault
        .prepare(
          "SELECT revoked_at FROM share_authority WHERE authority_id = ?"
        )
        .get(authorityId) as { revoked_at: string | null }
    ).revoked_at;
    expect(revokedAt).toBeTypeOf("string");
    const receipt = db.audit
      .prepare(
        `SELECT action, object_type, detail_json FROM access_receipt
          WHERE grant_id = ? ORDER BY receipt_id DESC LIMIT 1`
      )
      .get(authorityId) as
      | { action: string; object_type: string; detail_json: string }
      | undefined;
    expect(receipt).toMatchObject({
      action: "act share.revoke",
      object_type: "share.authority",
    });
    expect(JSON.parse(receipt!.detail_json)).toMatchObject({
      cause: "subject-purged",
      subjectType: "core.document",
      verb: "view",
    });
    expect(result.authorityRevoked).toBeGreaterThanOrEqual(1);
    expect(
      db.vault
        .prepare(
          "SELECT revoked_reason FROM share_authority WHERE authority_id = ?"
        )
        .get(authorityId)
    ).toMatchObject({ revoked_reason: "subject-purged" });
  });

  test("an answer past its own end date stops answering, and the sweep says so", () => {
    const past = "2020-01-01T00:00:00Z";
    const ravi = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party
           (party_id, kind, display_name, sort_name, created_at, updated_at)
         VALUES (?, 'person', 'Ravi', 'Ravi', ?, ?)`
      )
      .run(ravi, past, past);
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('until-body', 'text/plain', 'data:text/plain,z', 'sha-until-body', 1, ?)`
      )
      .run(past);
    db.vault
      .prepare(
        `INSERT INTO core_document (document_id, title, current_content_id, created_at, updated_at)
         VALUES ('until-doc', 'Trip plan', 'until-body', ?, ?)`
      )
      .run(past, past);
    const lapsed = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO share_authority
           (authority_id, principal_kind, principal_id, subject_type, subject_id,
            verb, duration, expires_at, decision, granted_at, granted_by)
         VALUES (?, 'person', ?, 'core.document', 'until-doc', 'view',
                 'until-date', ?, 'granted', ?, ?)`
      )
      .run(lapsed, ravi, past, past, boot.ownerPartyId);

    expect(
      readLiveShareGrant(
        db.vault,
        { kind: "party", id: ravi },
        "core.document",
        "until-doc"
      )
    ).toBeUndefined();

    const result = gw.sweep(owner);
    expect(result.authorityRevoked).toBeGreaterThanOrEqual(1);
    expect(
      db.vault
        .prepare(
          "SELECT revoked_reason FROM share_authority WHERE authority_id = ?"
        )
        .get(lapsed)
    ).toMatchObject({ revoked_reason: "expired" });
    const receipt = db.audit
      .prepare(
        `SELECT action, detail_json FROM access_receipt
          WHERE grant_id = ? ORDER BY receipt_id DESC LIMIT 1`
      )
      .get(lapsed) as { action: string; detail_json: string } | undefined;
    expect(receipt?.action).toBe("act share.revoke");
    expect(JSON.parse(receipt!.detail_json)).toMatchObject({
      cause: "expired",
    });
    expect(gw.sweep(owner).authorityRevoked).toBe(0);
  });

  test("lifecycle sweep purges a lapsed trashed document and its exclusively-owned content (issue #352)", () => {
    const now = new Date().toISOString();
    const past = "2020-01-01T00:00:00Z";
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('doc-body-1', 'text/plain', 'data:text/plain,x', 'sha-doc-body', 1, ?)`
      )
      .run(past);
    db.vault
      .prepare(
        `INSERT INTO core_document (document_id, title, current_content_id, created_at, updated_at, deleted_at, purge_at)
       VALUES ('d-lapsed', 'Lapsed', 'doc-body-1', ?, ?, ?, ?)`
      )
      .run(past, past, past, past);
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('doc-body-2', 'text/plain', 'data:text/plain,y', 'sha-doc-body-2', 1, ?)`
      )
      .run(now);
    db.vault
      .prepare(
        `INSERT INTO core_document (document_id, title, current_content_id, created_at, updated_at, deleted_at, purge_at)
       VALUES ('d-fresh', 'Fresh trash', 'doc-body-2', ?, ?, ?, '2999-01-01T00:00:00Z')`
      )
      .run(now, now, now);
    const result = gw.sweep(owner);
    expect(result.documentsPurged).toBe(1);
    expect(
      db.vault
        .prepare(`SELECT 1 FROM core_document WHERE document_id = 'd-lapsed'`)
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM core_content_item WHERE content_id = 'doc-body-1'`
        )
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(`SELECT 1 FROM core_document WHERE document_id = 'd-fresh'`)
        .get()
    ).toBeTruthy();
  });

  function seedPolyDependents(
    type: string,
    id: string
  ): {
    embeddingId: string;
    mapId: string;
    annotationId: string;
    attachmentId: string;
  } {
    const now = new Date().toISOString();
    const embeddingId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO enrich_embedding (embedding_id, target_type, target_id, model, dim, vector, created_at)
       VALUES (?, ?, ?, 'test-model', 1, ?, ?)`
      )
      .run(embeddingId, type, id, new Uint8Array([1, 2, 3, 4]), now);
    db.vault
      .prepare(
        `INSERT INTO enrich_request (request_id, target_type, target_id, reason, requested_at)
       VALUES (?, ?, ?, 'on-view', ?)`
      )
      .run(uuidv7(), type, id, now);
    const connId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO sync_connection (connection_id, kind, label, status, trust, created_at)
       VALUES (?, 'file', ?, 'active', 'staged', ?)`
      )
      .run(connId, `conn-${connId}`, now);
    const mapId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO sync_external_entity (map_id, connection_id, external_id, target_type, target_id, content_hash, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 'h', ?, ?)`
      )
      .run(mapId, connId, `ext-${mapId}`, type, id, now, now);
    const annotationId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO knowledge_annotation (annotation_id, author_party_id, target_type, target_id, body_text, created_at)
       VALUES (?, ?, ?, ?, 'margin note', ?)`
      )
      .run(annotationId, boot.ownerPartyId, type, id, now);
    const attachBytes = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'text/plain', 'data:text/plain,att', ?, 1, ?)`
      )
      .run(attachBytes, `sha-att-${attachBytes}`, now);
    const attachmentId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_attachment (attachment_id, target_type, target_id, content_id, role, is_primary, created_at)
       VALUES (?, ?, ?, ?, 'other', 0, ?)`
      )
      .run(attachmentId, type, id, attachBytes, now);
    return { embeddingId, mapId, annotationId, attachmentId };
  }

  function expectPolyDependentsCleaned(
    deps: ReturnType<typeof seedPolyDependents>,
    type: string,
    id: string
  ): void {
    expect(
      db.vault
        .prepare("SELECT 1 FROM enrich_embedding WHERE embedding_id = ?")
        .get(deps.embeddingId),
      "orphan embedding must be gone"
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          "SELECT 1 FROM enrich_request WHERE target_type = ? AND target_id = ? AND drained_at IS NULL"
        )
        .get(type, id),
      "open enrich request must be gone"
    ).toBeUndefined();
    expect(
      db.vault
        .prepare("SELECT 1 FROM sync_external_entity WHERE map_id = ?")
        .get(deps.mapId),
      "stale sync-map row must be gone"
    ).toBeUndefined();
    expect(
      db.vault
        .prepare("SELECT 1 FROM knowledge_annotation WHERE annotation_id = ?")
        .get(deps.annotationId),
      "annotation must be gone"
    ).toBeUndefined();
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_attachment WHERE attachment_id = ?")
        .get(deps.attachmentId),
      "attachment must be gone"
    ).toBeUndefined();
  }

  test("purge sweep cleans every polymorphic dependent of a purged content item (issue #441 A1)", () => {
    const past = "2020-01-01T00:00:00Z";
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at, deleted_at, purge_at)
       VALUES ('poly-c', 'text/plain', 'data:text/plain,x', 'sha-poly-c', 1, ?, ?, ?)`
      )
      .run(past, past, past);
    const deps = seedPolyDependents("core.content_item", "poly-c");
    const result = gw.sweep(owner);
    expect(result.contentPurged).toBe(1);
    expect(
      db.vault
        .prepare(`SELECT 1 FROM core_content_item WHERE content_id = 'poly-c'`)
        .get()
    ).toBeUndefined();
    expectPolyDependentsCleaned(deps, "core.content_item", "poly-c");
  });

  test("purge keeps derivative bytes another content item still claims (issue #750)", () => {
    const past = "2020-01-01T00:00:00Z";
    const now = new Date().toISOString();
    const shared = db.blobs.ingestSync(Buffer.from("purge-shared-thumb"));
    const lapsedOriginal = db.blobs.ingestSync(Buffer.from("purge-lapsed-og"));
    const liveOriginal = db.blobs.ingestSync(Buffer.from("purge-live-og"));
    const item = db.vault.prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at, deleted_at, purge_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?, ?, ?)`
    );
    item.run(
      "purge-shared-a",
      blobUriFor(lapsedOriginal.sha256),
      lapsedOriginal.sha256,
      lapsedOriginal.byteSize,
      past,
      past,
      past
    );
    item.run(
      "purge-shared-b",
      blobUriFor(liveOriginal.sha256),
      liveOriginal.sha256,
      liveOriginal.byteSize,
      now,
      null,
      null
    );
    const derivative = db.vault.prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
       VALUES (?, ?, 'thumb', ?, 'image/jpeg', ?, NULL, ?)`
    );
    derivative.run(
      uuidv7(),
      "purge-shared-a",
      shared.sha256,
      shared.byteSize,
      past
    );
    derivative.run(
      uuidv7(),
      "purge-shared-b",
      shared.sha256,
      shared.byteSize,
      now
    );

    const result = gw.sweep(owner);
    expect(result.contentPurged).toBe(1);
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM core_content_item WHERE content_id = 'purge-shared-a'`
        )
        .get()
    ).toBeUndefined();
    expect(db.blobs.hasSync(lapsedOriginal.sha256)).toBe(false);
    expect(db.blobs.hasSync(shared.sha256)).toBe(true);
    expect(db.blobs.hasSync(liveOriginal.sha256)).toBe(true);
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM core_content_derivative WHERE content_id = 'purge-shared-b'`
        )
        .get()
    ).toBeTruthy();
  });

  test("purge sweep cleans every polymorphic dependent of a purged media asset (issue #441 A1)", () => {
    const now = new Date().toISOString();
    const past = "2020-01-01T00:00:00Z";
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES ('poly-asset-body', 'image/jpeg', 'data:image/jpeg,x', 'sha-poly-asset', 1, ?)`
      )
      .run(now);
    db.vault
      .prepare(
        `INSERT INTO media_asset (asset_id, content_id, kind, deleted_at, purge_at)
       VALUES ('poly-a', 'poly-asset-body', 'photo', ?, ?)`
      )
      .run(past, past);
    const deps = seedPolyDependents("media.asset", "poly-a");
    const result = gw.sweep(owner);
    expect(result.assetsPurged).toBe(1);
    expect(
      db.vault
        .prepare(`SELECT 1 FROM media_asset WHERE asset_id = 'poly-a'`)
        .get()
    ).toBeUndefined();
    expectPolyDependentsCleaned(deps, "media.asset", "poly-a");
  });

  const PAST = "2020-01-01T00:00:00Z";

  function seedContent(id: string, lapsed: boolean): void {
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, created_at, deleted_at, purge_at)
         VALUES (?, 'image/jpeg', ?, ?, 1, ?, ?, ?)`
      )
      .run(
        id,
        `data:image/jpeg,${id}`,
        `sha-${id}`,
        PAST,
        lapsed ? PAST : null,
        lapsed ? PAST : null
      );
  }

  function seedAsset(
    assetId: string,
    opts: { lapsed: boolean; sourceAssetId?: string }
  ): void {
    seedContent(`${assetId}-body`, false);
    db.vault
      .prepare(
        `INSERT INTO media_asset
           (asset_id, content_id, kind, source_asset_id, deleted_at, purge_at)
         VALUES (?, ?, 'photo', ?, ?, ?)`
      )
      .run(
        assetId,
        `${assetId}-body`,
        opts.sourceAssetId ?? null,
        opts.lapsed ? PAST : null,
        opts.lapsed ? PAST : null
      );
  }

  function seedLaterDuty(): void {
    db.vault
      .prepare(
        `INSERT INTO social_thread (thread_id, channel, created_at) VALUES ('th-late', 'sms', ?)`
      )
      .run(PAST);
    seedContent("msg-body", false);
    db.vault
      .prepare(
        `INSERT INTO social_message (message_id, thread_id, sender_handle, sent_at, body_content_id, delivery)
         VALUES ('m-stale', 'th-late', 'x@y.z', ?, 'msg-body', 'read')`
      )
      .run(PAST);
    db.vault
      .prepare(
        `INSERT INTO access_policy (policy_id, kind, entity, rule_json, retention_days, effective_from, priority)
         VALUES (?, 'retention', 'social.message', '{"timestamp_column":"sent_at"}', 365, '2019-01-01T00:00:00Z', 1)`
      )
      .run(uuidv7());
  }

  test("lifecycle sweep skips a lapsed photograph whose derived edit is still live, and keeps sweeping (issue #711 S8)", () => {
    seedAsset("a-source", { lapsed: true });
    seedAsset("a-edit", { lapsed: false, sourceAssetId: "a-source" });
    seedLaterDuty();

    const result = gw.sweep(owner);

    expect(result.assetsPurged).toBe(0);
    expect(result.assetsBlockedByLineage).toStrictEqual(["a-source"]);
    expect(
      db.vault
        .prepare(`SELECT 1 FROM media_asset WHERE asset_id = 'a-source'`)
        .get(),
      "the source must survive rather than be force-deleted"
    ).toBeTruthy();
    expect(
      db.vault
        .prepare(`SELECT 1 FROM media_asset WHERE asset_id = 'a-edit'`)
        .get(),
      "the live edit the member never trashed must be untouched"
    ).toBeTruthy();
    expect(result.retentionDeleted).toBe(1);
    expect(result.receiptId).toBeTruthy();
  });

  test("lifecycle sweep purges a lapsed edit before its lapsed source in one pass (issue #711 S8)", () => {
    seedAsset("a-source", { lapsed: true });
    seedAsset("a-edit", { lapsed: true, sourceAssetId: "a-source" });
    seedLaterDuty();

    const result = gw.sweep(owner);

    expect(result.assetsPurged).toBe(2);
    expect(result.assetsBlockedByLineage).toStrictEqual([]);
    const remaining = db.vault
      .prepare("SELECT count(*) AS n FROM media_asset")
      .get() as { n: number };
    expect(
      remaining.n,
      "trashing a photograph and its edit together empties both in one sweep"
    ).toBe(0);
    expect(result.retentionDeleted).toBe(1);
  });

  test("a deep lapsed lineage drains in one pass, without re-asking per generation (#883 C2)", () => {
    const depth = 24;
    for (let index = 0; index < depth; index += 1) {
      seedAsset(
        `chain-${index}`,
        index === 0
          ? { lapsed: true }
          : { lapsed: true, sourceAssetId: `chain-${index - 1}` }
      );
    }
    seedLaterDuty();

    let statements = 0;
    const original = db.vault.prepare.bind(db.vault);
    Object.defineProperty(db.vault, "prepare", {
      configurable: true,
      value: ((sql: string) => {
        if (/FROM media_asset WHERE source_asset_id/u.test(sql))
          statements += 1;
        return original(sql);
      }) as typeof db.vault.prepare,
    });
    let result;
    try {
      result = gw.sweep(owner);
    } finally {
      Object.defineProperty(db.vault, "prepare", {
        configurable: true,
        value: original,
      });
    }

    expect(result.assetsPurged).toBe(depth);
    expect(result.assetsBlockedByLineage).toStrictEqual([]);
    expect(
      (
        db.vault.prepare("SELECT count(*) AS n FROM media_asset").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
    expect(
      statements,
      "the asset purge re-asked SQLite about lineage per generation"
    ).toBeLessThanOrEqual(depth + 1);
    expect(result.retentionDeleted).toBe(1);
  });

  test("a lapsed asset whose derived copy is NOT lapsed still blocks, one pass or many (#883 C2)", () => {
    seedAsset("keep-source", { lapsed: true });
    seedAsset("keep-edit", { lapsed: false, sourceAssetId: "keep-source" });
    seedAsset("free-standing", { lapsed: true });
    seedLaterDuty();

    const result = gw.sweep(owner);

    expect(result.assetsPurged).toBe(1);
    expect(result.assetsBlockedByLineage).toStrictEqual(["keep-source"]);
    expect(result.retentionDeleted).toBe(1);
  });

  test("the thread projection heals what drifted and rewrites nothing else (#883 C2)", () => {
    db.vault
      .prepare(
        `INSERT INTO social_thread (thread_id, channel, created_at, last_message_at)
         VALUES ('th-fresh', 'sms', ?, ?)`
      )
      .run(PAST, PAST);
    seedContent("msg-1-body", false);
    db.vault
      .prepare(
        `INSERT INTO social_message
           (message_id, thread_id, sender_handle, sent_at, body_content_id, delivery)
         VALUES ('msg-1', 'th-fresh', '+15550100', ?, 'msg-1-body', 'delivered')`
      )
      .run(PAST);
    db.vault
      .prepare(
        `INSERT INTO social_thread (thread_id, channel, created_at) VALUES ('th-empty', 'sms', ?)`
      )
      .run(PAST);
    gw.sweep(owner);

    const changesBefore = (
      db.vault.prepare("SELECT total_changes() AS n").get() as { n: number }
    ).n;
    gw.sweep(owner);
    const settled = (
      db.vault.prepare("SELECT total_changes() AS n").get() as { n: number }
    ).n;

    db.vault
      .prepare(
        "UPDATE social_thread SET last_message_at = NULL WHERE thread_id = 'th-fresh'"
      )
      .run();
    gw.sweep(owner);
    expect(
      (
        db.vault
          .prepare(
            "SELECT last_message_at AS at FROM social_thread WHERE thread_id = 'th-fresh'"
          )
          .get() as { at: string | null }
      ).at,
      "a thread whose projection drifted is repaired"
    ).toBe(PAST);
    expect(settled - changesBefore).toBeLessThan(2);
  });

  test("lifecycle sweep declines a lapsed content item whose asset is a lineage source (issue #711 S8)", () => {
    seedAsset("a-source", { lapsed: true });
    db.vault
      .prepare(
        "UPDATE core_content_item SET deleted_at = ?, purge_at = ? WHERE content_id = 'a-source-body'"
      )
      .run(PAST, PAST);
    seedAsset("a-edit", { lapsed: false, sourceAssetId: "a-source" });
    seedLaterDuty();

    const result = gw.sweep(owner);

    expect(result.contentPurged).toBe(0);
    expect(result.contentBlockedByLineage).toStrictEqual(["a-source-body"]);
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM core_content_item WHERE content_id = 'a-source-body'`
        )
        .get(),
      "bytes stay put while the asset that rents them cannot go"
    ).toBeTruthy();
    expect(result.retentionDeleted).toBe(1);
  });

  test("lifecycle sweep purges lapsed trashed People/Tally rows and cleans their poly refs (issue #441 A4)", () => {
    const now = new Date().toISOString();
    const past = "2020-01-01T00:00:00Z";
    db.vault
      .prepare(
        `INSERT INTO core_party
         (party_id, kind, display_name, created_at, updated_at)
       VALUES ('sweep-friend', 'person', 'Sweep Friend', ?, ?)`
      )
      .run(now, now);
    db.vault
      .prepare(
        `INSERT INTO tally_obligation
         (obligation_id, from_party, to_party, amount_minor, currency, incurred_on,
          created_at, deleted_at, purge_at)
       VALUES ('poly-obligation', ?, ?, 100, 'USD', '2020-01-01', ?, ?, ?)`
      )
      .run("sweep-friend", boot.ownerPartyId, past, past, past);
    const deps = seedPolyDependents("tally.obligation", "poly-obligation");
    db.vault
      .prepare(
        `INSERT INTO tally_obligation
         (obligation_id, from_party, to_party, amount_minor, currency, incurred_on,
          created_at, deleted_at, purge_at)
       VALUES ('poly-obligation-fresh', ?, ?, 100, 'USD', '2020-01-01', ?, ?, '2999-01-01T00:00:00Z')`
      )
      .run("sweep-friend", boot.ownerPartyId, now, now);
    const result = gw.sweep(owner);
    expect(result.domainRowsPurged).toBe(1);
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM tally_obligation WHERE obligation_id = 'poly-obligation'`
        )
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM tally_obligation WHERE obligation_id = 'poly-obligation-fresh'`
        )
        .get()
    ).toBeTruthy();
    expectPolyDependentsCleaned(deps, "tally.obligation", "poly-obligation");
  });

  test("lapsed People trash erases the party, tags, and channels so they cannot notify (#864)", () => {
    const now = new Date().toISOString();
    const past = "2020-01-01T00:00:00Z";
    db.vault
      .prepare(
        `INSERT INTO core_party
         (party_id, kind, display_name, birth_date, created_at, updated_at)
       VALUES ('erase-friend', 'person', 'Erase Friend', '--03-14', ?, ?)`
      )
      .run(now, now);
    db.vault
      .prepare(
        `INSERT INTO people_profile
         (profile_id, party_id, role, avatar_color, cadence_days, last_contacted_at, met, created_at, deleted_at, purge_at)
       VALUES ('erase-profile', 'erase-friend', 'friend', NULL, 14, NULL, NULL, ?, ?, ?)`
      )
      .run(past, past, past);
    db.vault
      .prepare(
        `INSERT INTO core_party_identifier
         (identifier_id, party_id, scheme, value, is_primary, valid_from)
       VALUES ('erase-ident', 'erase-friend', 'url', 'https://erase-friend.example', 1, ?)`
      )
      .run(now);
    db.vault
      .prepare(
        `INSERT INTO social_contact_channel
         (channel_id, party_id, kind, label, value, normalized_value, is_preferred, created_at, updated_at)
       VALUES ('erase-channel', 'erase-friend', 'email', NULL, 'erase-friend@example.com', 'erase-friend@example.com', 0, ?, ?)`
      )
      .run(now, now);
    db.vault
      .prepare(
        `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_at)
       VALUES ('erase-tag', 'core.party', 'erase-friend', ?, ?)`
      )
      .run(boot.concepts["anomaly"] as string, now);

    const result = gw.sweep(owner);
    expect(result.domainRowsPurged).toBeGreaterThanOrEqual(1);
    expect(
      db.vault
        .prepare("SELECT 1 FROM people_profile WHERE party_id = 'erase-friend'")
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare("SELECT 1 FROM core_party WHERE party_id = 'erase-friend'")
        .get(),
      "purged person must not remain as a party the agenda can notify"
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          "SELECT 1 FROM core_party_identifier WHERE party_id = 'erase-friend'"
        )
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          "SELECT 1 FROM social_contact_channel WHERE party_id = 'erase-friend'"
        )
        .get()
    ).toBeUndefined();
    expect(
      db.vault
        .prepare(
          "SELECT 1 FROM core_tag WHERE target_type = 'core.party' AND target_id = 'erase-friend'"
        )
        .get()
    ).toBeUndefined();
  });

  async function fileBackedVault(): Promise<{
    gw2: Gateway;
    owner2: Credential;
  }> {
    custodyDir = await tempDir("vault-custody-");
    fileDb = openVaultDb({ dir: custodyDir });
    const boot2 = bootstrapVault(fileDb, { ownerName: "Priya" });
    const gw2 = createGateway(fileDb);
    return {
      gw2,
      owner2: {
        kind: "device",
        deviceId: boot2.deviceId,
        deviceKey: boot2.deviceKey,
      },
    };
  }

  test("file custody: checkpoint, verifiable backup; ext band retained through revocation", async () => {
    const { gw2, owner2 } = await fileBackedVault();
    expect(gw2.checkpoint(owner2)).toStrictEqual({
      vault: "truncated",
    });

    const backupDir = path.join(custodyDir, "backups");
    await fs.mkdir(backupDir);
    const backup = gw2.backup(owner2, backupDir);
    expect(existsSync(backup.vaultPath)).toBe(true);
    expect(backup.vaultSha256).toMatch(/^[0-9a-f]{64}$/u);

    if (!fileDb) throw new Error("vault gone");
    const app = enrollApp(fileDb, { name: "gen-app" });
    const bootRow = fileDb.vault
      .prepare("SELECT self_party_id FROM core_vault")
      .get() as {
      self_party_id: string;
    };
    const purpose = fileDb.vault
      .prepare(
        `SELECT concept_id FROM core_concept WHERE notation = 'dpv:ServiceProvision'`
      )
      .get() as { concept_id: string };
    const grantId = createGrant(fileDb, {
      appId: app.appId,
      purposeConceptId: purpose.concept_id,
      grantedByPartyId: bootRow.self_party_id,
      scopes: [{ schema: "schedule", verbs: "read" }],
    });
    gw2.applyAppExt(owner2, "gen-app", [
      {
        name: "scratch",
        columns: [{ name: "scratch_id", type: "text", primaryKey: true }],
      },
    ]);
    const revocation = gw2.revokeGrant(owner2, grantId);
    expect(revocation.extRetained).toStrictEqual(["scratch"]);
    const row = fileDb.vault
      .prepare(
        `SELECT status FROM access_app_ext WHERE app_id = 'gen-app' AND table_name = 'scratch'`
      )
      .get() as { status: string };
    expect(row.status).toBe("retained"); // table + rows survive uninstall
  });

  test("file custody refuses in-memory vaults", () => {
    expect(() => gw.checkpoint(owner)).toThrow(/file-backed/u);
  });
});
