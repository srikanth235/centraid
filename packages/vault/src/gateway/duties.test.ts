import { existsSync, promises as fs } from "node:fs";
// governance: allow-repo-hygiene file-size-limit one lifecycle sweep, one spec — the purge matrix (content/note/document/asset/domain-trash × every polymorphic mechanism in poly-refs.ts) is a single table of invariants; splitting it would scatter the completeness argument the registry exists to make
// Tests for the §10 responsibilities closed after the first pass: polymorphic
// ref validation (S4), contract version check (S3), retention policy sweeps,
// the view service, and file custody.
import path from "node:path";

import { afterEach, assert, beforeEach, describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { bootstrappedVault } from "@centraid/test-kit/vault";

import { blobUriFor } from "../blob/store.js";
import { bootstrapVault, createGrant, enrollApp } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
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

  // ---- file custody (needs a file-backed vault) ----

  let custodyDir: string;
  let fileDb: VaultDb | null = null;

  afterEach(async () => {
    fileDb?.close();
    fileDb = null;
    if (custodyDir) await fs.rm(custodyDir, { recursive: true, force: true });
    custodyDir = "";
  });

  /** A scratch command that tags an arbitrary (type, id) pair. */
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
    expect(outcome.reason).toContain("does not resolve to a live row");
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
    expect(outcome.reason).toContain("unknown entity");
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
        `INSERT INTO consent_policy (policy_id, kind, applies_schema, applies_table, rule_json, retention_days, effective_from, priority)
       VALUES (?, 'retention', 'social', 'message', '{"timestamp_column":"sent_at"}', 365, '2020-01-01T00:00:00Z', 1)`
      )
      .run(uuidv7());
    const result = gw.sweep(owner);
    expect(result.retentionDeleted).toBe(1);
    const remaining = db.vault
      .prepare("SELECT message_id FROM social_message")
      .all();
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect(remaining.map((row) => ({ ...row }))).toStrictEqual([
      { message_id: "m-new" },
    ]);
  });

  // THE SABOTAGE TARGET (#712 P11): drop the media.asset entry from
  // RETENTION_REFUSALS in duties.ts and this goes red — the policy would fall
  // through to the missing-column skip and the refusal would lose its stated
  // reason, which is exactly the "runs and silently retains nothing" duty the
  // item exists to forbid.
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
        `INSERT INTO consent_policy (policy_id, kind, applies_schema, applies_table, rule_json, retention_days, effective_from, priority)
       VALUES (?, 'retention', 'media', 'media_asset', '{}', 30, '2020-01-01T00:00:00Z', 1)`
      )
      .run(uuidv7());
    const result = gw.sweep(owner);
    expect(result.retentionDeleted).toBe(0);
    expect(result.retentionRefused).toHaveLength(1);
    expect(result.retentionRefused[0]?.entity).toBe("media.asset");
    expect(result.retentionRefused[0]?.reason).toContain("trash lifecycle");
    // The asset outlives the policy: retention never reaches this table.
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
    // A trashed note still inside its window survives the sweep.
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
    // The lapsed note, its annotation, and its body row are gone together…
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
    // …while the in-window one waits for its grace period.
    expect(
      db.vault
        .prepare(`SELECT 1 FROM knowledge_note WHERE note_id = 'n-fresh'`)
        .get()
    ).toBeTruthy();
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
    // A trashed document still inside its window survives the sweep.
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

  /**
   * Seed one of every registered polymorphic dependent pointing at (type, id):
   * a vector embedding, a sync-map row, a margin annotation, and an
   * attachment. The attachment carries its OWN bytes (a second content
   * item) so it never blocks the target's deletion. Returns the ids to assert on.
   */
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
    // A drained request stays (inert history); an open one must go.
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
    // sha256 is UNIQUE on content items but NOT on derivatives: two items'
    // thumbs may legally share one CAS entry. Purging the lapsed item must
    // reclaim only its exclusively-owned bytes.
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
    // The lapsed item's exclusively-owned original is reclaimed with its rows…
    expect(
      db.vault
        .prepare(
          `SELECT 1 FROM core_content_item WHERE content_id = 'purge-shared-a'`
        )
        .get()
    ).toBeUndefined();
    expect(db.blobs.hasSync(lapsedOriginal.sha256)).toBe(false);
    // …but the SHARED thumb bytes survive: the live item's derivative still
    // claims them, and the survivor keeps reading its own thumb.
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
    // The asset's bytes are NOT purged here — asset meaning and byte custody have
    // independent lifecycles; only the asset row lapses.
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

  // ---- edit lineage vs the sweep (issue #711 decision S8) ----

  const PAST = "2020-01-01T00:00:00Z";

  /** A content item, lapsed-trashed when `lapsed`. */
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

  /** A photo asset over its own bytes, lapsed-trashed when `lapsed`. */
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

  /**
   * A retention policy with exactly one row past its window. It is enforced
   * near the END of the sweep, after every purge pass, so `retentionDeleted
   * === 1` is the assertion that the pass did not abort halfway: a FOREIGN KEY
   * error in a purge above takes this duty (and the receipt) down with it.
   */
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
        `INSERT INTO consent_policy (policy_id, kind, applies_schema, applies_table, rule_json, retention_days, effective_from, priority)
         VALUES (?, 'retention', 'social', 'message', '{"timestamp_column":"sent_at"}', 365, '2019-01-01T00:00:00Z', 1)`
      )
      .run(uuidv7());
  }

  test("lifecycle sweep skips a lapsed photograph whose derived edit is still live, and keeps sweeping (issue #711 S8)", () => {
    seedAsset("a-source", { lapsed: true });
    seedAsset("a-edit", { lapsed: false, sourceAssetId: "a-source" });
    seedLaterDuty();

    const result = gw.sweep(owner);

    // The self-FK would have aborted the pass; instead the row is declined…
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
    // …and every duty after the purge still ran.
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

  test("lifecycle sweep declines a lapsed content item whose asset is a lineage source (issue #711 S8)", () => {
    // The delete_asset flow lapses the asset and its bytes together, so this
    // is the same member action as the first test seen from the content pass.
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
         (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('sweep-friend', 'person', 'Sweep Friend', ?, ?, '1.3')`
      )
      .run(now, now);
    // A lapsed trashed Tally obligation (representative of the table-driven set).
    db.vault
      .prepare(
        `INSERT INTO tally_obligation
         (obligation_id, from_party, to_party, amount_minor, currency, incurred_on,
          created_at, deleted_at, purge_at)
       VALUES ('poly-obligation', ?, ?, 100, 'USD', '2020-01-01', ?, ?, ?)`
      )
      .run("sweep-friend", boot.ownerPartyId, past, past, past);
    const deps = seedPolyDependents("tally.obligation", "poly-obligation");
    // A trashed row still inside its grace window must survive the sweep.
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
         (party_id, kind, display_name, birth_date, created_at, updated_at, ontology_version)
       VALUES ('erase-friend', 'person', 'Erase Friend', '--03-14', ?, ?, '1.3')`
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
       VALUES ('erase-ident', 'erase-friend', 'email', 'erase-friend@example.com', 1, ?)`
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

  function calendarAppWithEvent(): { cred: Credential; appId: string } {
    const app = enrollApp(db, { name: "agenda-widget", origin: "generated" });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts["dpv:ServiceProvision"] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [
        {
          schema: "core",
          table: "event",
          verbs: "read",
          fieldMask: ["event_id", "summary", "dtstart", "location_place_id"],
        },
      ],
    });
    const placeId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_place (place_id, name, kind, created_at) VALUES (?, 'Clinic', 'venue', ?)`
      )
      .run(placeId, new Date().toISOString());
    db.vault
      .prepare(
        `INSERT INTO core_event (event_id, summary, description, dtstart, status, location_place_id, sequence, created_at, updated_at)
       VALUES (?, 'Cardiology', 'secret notes', '2026-07-09T10:30:00Z', 'confirmed', ?, 0, ?, ?)`
      )
      .run(
        uuidv7(),
        placeId,
        new Date().toISOString(),
        new Date().toISOString()
      );
    return {
      cred: { kind: "app", appId: app.appId, signingKey: app.signingKey },
      appId: app.appId,
    };
  }

  test("view service: registration proves joins follow declared FKs", () => {
    const { cred } = calendarAppWithEvent();
    expect(() =>
      gw.registerView(cred, {
        name: "agenda",
        baseEntity: "core.event",
        definition: {
          columns: ["event_id", "summary"],
          joins: [
            { entity: "core.place", fk_column: "summary", columns: ["name"] },
          ], // not an FK
        },
      })
    ).toThrow(/not a declared FK/u);
    const viewId = gw.registerView(cred, {
      name: "agenda",
      baseEntity: "core.event",
      definition: {
        columns: ["event_id", "summary", "dtstart", "description"],
        where: [{ column: "status", op: "eq", value: "confirmed" }],
        joins: [
          {
            entity: "core.place",
            fk_column: "location_place_id",
            columns: ["name"],
          },
        ],
      },
    });
    expect(viewId).toBeTruthy();
  });

  test("view service: execution clamps to grant scopes — mask trims columns, join needs consent", () => {
    const { cred, appId } = calendarAppWithEvent();
    gw.registerView(cred, {
      name: "agenda",
      baseEntity: "core.event",
      definition: {
        columns: ["event_id", "summary", "description"], // description exceeds the field mask
        joins: [
          {
            entity: "core.place",
            fk_column: "location_place_id",
            columns: ["name"],
          },
        ],
      },
    });
    // The grant covers core.event only — the join to core.place must deny.
    expect(() => gw.queryView(cred, "agenda", "dpv:ServiceProvision")).toThrow(
      /join core.place/u
    );
    // Widen the grant to the place table; now it executes, but the field mask
    // still strips `description` — the view cannot over-read.
    createGrant(db, {
      appId,
      purposeConceptId: boot.concepts["dpv:ServiceProvision"] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [
        {
          schema: "core",
          table: "place",
          verbs: "read",
          fieldMask: ["place_id", "name"],
        },
      ],
    });
    const result = gw.queryView(cred, "agenda", "dpv:ServiceProvision");
    expect(result.rows).toHaveLength(1);
    expect(Object.keys(result.rows[0] ?? {}).sort()).toStrictEqual([
      "event_id",
      "place_name",
      "summary",
    ]);
    expect(result.rows[0]).toMatchObject({
      summary: "Cardiology",
      place_name: "Clinic",
    });
    // Both the deny and the allow left receipts (same-ms UUIDv7s, so no order).
    const receipts = db.journal
      .prepare(
        `SELECT decision FROM consent_receipt WHERE action = 'read view:agenda' ORDER BY decision`
      )
      .all();
    expect(receipts.map((row) => ({ ...row }))).toStrictEqual([
      { decision: "allow" },
      { decision: "deny" },
    ]);
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
      journal: "truncated",
    });

    const backupDir = path.join(custodyDir, "backups");
    await fs.mkdir(backupDir);
    const backup = gw2.backup(owner2, backupDir);
    expect(existsSync(backup.vaultPath)).toBe(true);
    expect(existsSync(backup.journalPath)).toBe(true);
    expect(backup.vaultSha256).toMatch(/^[0-9a-f]{64}$/u);

    // ext band: applied for the app, RETAINED (not dropped) when its last
    // grant is revoked — the data is the owner's; purging is a separate act.
    if (!fileDb) throw new Error("vault gone");
    const app = enrollApp(fileDb, { name: "gen-app", origin: "generated" });
    const bootRow = fileDb.vault
      .prepare("SELECT owner_party_id FROM core_vault")
      .get() as {
      owner_party_id: string;
    };
    const purpose = fileDb.vault
      .prepare(
        `SELECT concept_id FROM core_concept WHERE notation = 'dpv:ServiceProvision'`
      )
      .get() as { concept_id: string };
    const grantId = createGrant(fileDb, {
      appId: app.appId,
      purposeConceptId: purpose.concept_id,
      grantedByPartyId: bootRow.owner_party_id,
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
        `SELECT status FROM consent_app_ext WHERE app_id = 'gen-app' AND table_name = 'scratch'`
      )
      .get() as { status: string };
    expect(row.status).toBe("retained"); // table + rows survive uninstall
  });

  test("file custody refuses in-memory vaults", () => {
    expect(() => gw.checkpoint(owner)).toThrow(/file-backed/u);
  });
});
