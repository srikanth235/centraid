import { assert, beforeEach, describe, expect, test, vi } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault, createGrant, enrollApp } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerScheduleCommands } from "../commands/schedule.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createShareGrant, setFulfillmentState } from "../grant/grant-store.js";
import { sha256Hex, uuidv7 } from "../ids.js";
import {
  acknowledgeCommonsSeatCursor,
  appendCommonsOperation,
  createCommonsGrant,
  queueCommonsIntent,
} from "../share/commons.js";
import type { Gateway } from "./gateway.js";
import { createGateway } from "./gateway.js";
import { canonicalJson, importVaultExport } from "./portability.js";
import type { Credential } from "./types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("portability", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    gw = createGateway(db);
    registerScheduleCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function seedLife(): void {
    const calendarId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility)
       VALUES (?, ?, 'Personal', 'Asia/Kolkata', 'private')`
      )
      .run(calendarId, boot.ownerPartyId);
    const outcome = gw.invoke(owner, {
      command: "schedule.propose_event",
      input: {
        summary: "Workshop",
        dtstart: "2026-07-10T09:00:00Z",
        dtend: "2026-07-10T12:00:00Z",
        calendar_id: calendarId,
        attendee_party_ids: [boot.ownerPartyId],
      },
      purpose: "dpv:ServiceProvision",
    });
    if (outcome.status !== "executed")
      throw new Error(`seed failed: ${JSON.stringify(outcome)}`);
    gw.invoke(owner, {
      command: "schedule.respond_rsvp",
      input: {
        event_id: (outcome.output as { event_id: string }).event_id,
        party_id: boot.ownerPartyId,
        partstat: "accepted",
      },
      purpose: "dpv:ServiceProvision",
    });
    const app = enrollApp(db, { name: "calendar-app", riskCeiling: "medium" });
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts["dpv:ServiceProvision"] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: "schedule", verbs: "read" }],
    });
  }

  test("respond_rsvp drives the RFC 5545 state machine", () => {
    seedLife();
    const attendee = db.vault
      .prepare("SELECT partstat, responded_at FROM schedule_attendee")
      .get() as { partstat: string; responded_at: string | null };
    expect(attendee.partstat).toBe("accepted");
    expect(attendee.responded_at).not.toBeNull();
  });

  test("respond_rsvp denies a party that was never invited", () => {
    seedLife();
    const event = db.vault.prepare("SELECT event_id FROM core_event").get() as {
      event_id: string;
    };
    const outcome = gw.invoke(owner, {
      command: "schedule.respond_rsvp",
      input: {
        event_id: event.event_id,
        party_id: uuidv7(),
        partstat: "declined",
      },
      purpose: "dpv:ServiceProvision",
    });
    expect(outcome.status).toBe("failed");
    assert(outcome.status === "failed");
    expect(outcome.predicate).toContain("attendee_invited");
  });

  test("export → reimport → re-export round-trips losslessly (§11 gate)", () => {
    seedLife();
    const first = gw.exportVault(owner);
    expect(first.artifact.verifyHash).toMatch(/^[0-9a-f]{64}$/u);
    const receipt = db.audit
      .prepare(
        "SELECT object_type, object_id, detail_json FROM access_receipt WHERE receipt_id = ?"
      )
      .get(first.receiptId) as {
      object_type: string;
      object_id: string;
      detail_json: string | null;
    };
    expect(receipt.object_type).toBe("core.vault");
    expect(
      (JSON.parse(receipt.detail_json ?? "{}") as { exportId?: string })
        .exportId
    ).toBe(first.exportId);
    expect(
      (JSON.parse(receipt.detail_json ?? "{}") as { verifyHash?: string })
        .verifyHash
    ).toBe(first.artifact.verifyHash);

    const restored = openVaultDb();
    const { imported } = importVaultExport(restored, first.artifact);
    expect(imported).toBeGreaterThan(20);
    const party = restored.vault
      .prepare(
        "SELECT party_id, display_name FROM core_party WHERE party_id = ?"
      )
      .get(boot.ownerPartyId) as { party_id: string; display_name: string };
    expect(party).toMatchObject({
      party_id: boot.ownerPartyId,
      display_name: "Priya",
    });

    const gw2 = createGateway(restored);
    const events = gw2.read(owner, {
      entity: "core.event",
      purpose: "dpv:ServiceProvision",
    });
    expect(events.rows).toHaveLength(1);

    const second = gw2.exportVault(owner);
    expect(second.artifact.verifyHash).toBe(first.artifact.verifyHash);
    restored.close();
  });

  test("portable restore retains every Commons truth and mechanics table", () => {
    const now = "2026-08-10T00:00:00.000Z";
    const documentId = uuidv7();
    const contentId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'text/plain', 'data:text/plain,x', ?, 1, ?)`
      )
      .run(contentId, `sha-${contentId}`.padEnd(64, "0"), now);
    db.vault
      .prepare(
        `INSERT INTO core_document
           (document_id, title, current_content_id, created_at, updated_at)
         VALUES (?, 'Portable plan', ?, ?, ?)`
      )
      .run(documentId, contentId, now, now);
    const grant = createCommonsGrant({
      origin: db.vault,
      ownerPartyId: boot.ownerPartyId,
      ownerVaultId: boot.vaultId,
      ownerVault: db,
      containerType: "core.document",
      containerId: documentId,
      members: [],
      now,
    });
    appendCommonsOperation({
      steward: db.vault,
      grantId: grant.grantId,
      actorPartyId: boot.ownerPartyId,
      kind: "command",
      command: "core.rename_document",
      input: { document_id: grant.containerId },
      outcome: "refused",
      reason: "portable proof",
      now,
    });
    db.vault
      .prepare(
        `INSERT INTO share_commons_replay
           (grant_id, signing_vault_id, signature_nonce, sequence, outcome, reason)
         VALUES (?, 'portable-member-vault', 'portable-nonce', 1,
                 'refused', 'portable replay proof')`
      )
      .run(grant.grantId);
    db.vault
      .prepare(
        `INSERT INTO share_commons_receipt
           (grant_id, sequence, kind, actor_party_id, outcome, reason, created_at)
         VALUES (?, 1, 'command', ?, 'refused',
                 'portable receipt proof', ?)`
      )
      .run(grant.grantId, boot.ownerPartyId, now);
    acknowledgeCommonsSeatCursor({
      steward: db.vault,
      grantId: grant.grantId,
      memberVaultId: boot.vaultId,
      sequence: 1,
      now,
    });
    db.vault
      .prepare(
        `INSERT INTO share_commons_lineage
           (grant_id, target_type, target_id, origin_item_id)
         VALUES (?, 'core.document', ?, ?)`
      )
      .run(grant.grantId, grant.containerId, grant.containerId);
    db.vault
      .prepare(
        `INSERT INTO share_commons_retained
           (grant_id, target_type, target_id, retained_at)
         VALUES (?, 'core.document', ?, ?)`
      )
      .run(grant.grantId, documentId, now);
    queueCommonsIntent({
      seat: db.vault,
      intentId: "portable-intent",
      grantId: grant.grantId,
      actorPartyId: boot.ownerPartyId,
      command: "core.rename_document",
      commandInput: { document_id: grant.containerId },
      stewardLabel: "Priya",
      now,
    });
    db.vault
      .prepare(
        `INSERT INTO share_commons_invitation
           (invitation_id, grant_id, steward_vault_id, member_vault_id,
            member_party_id, capability, container_type, container_id,
            container_label, current_size_bytes, max_size_bytes,
            status, created_at, answered_at)
         VALUES ('portable-invite', ?, ?, 'remote-vault', ?, 'read',
                 'core.document', ?, 'Portable invite', 42, NULL,
                 'pending', ?, NULL)`
      )
      .run(
        grant.grantId,
        boot.vaultId,
        boot.ownerPartyId,
        grant.containerId,
        now
      );

    const peerPartyId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
         VALUES (?, 'person', 'Peer', ?, ?)`
      )
      .run(peerPartyId, now, now);
    db.vault
      .prepare(
        `INSERT INTO share_party_vault_binding
           (binding_id, party_id, vault_id, vault_public_key, linked_at, revoked_at)
         VALUES (?, ?, 'remote-vault', NULL, ?, NULL)`
      )
      .run(uuidv7(), peerPartyId, now);

    const { artifact } = gw.exportVault(owner);
    const commonsEntities = [
      "share.party_vault_binding",
      "share.circle_grant",
      "share.commons_member_state",
      "share.commons_op",
      "share.commons_replay",
      "share.commons_receipt",
      "share.commons_cursor",
      "share.commons_lineage",
      "share.commons_retained",
      "share.commons_intent",
      "share.commons_invitation",
    ];
    for (const entity of commonsEntities)
      expect(artifact.tables[entity]?.length, entity).toBeGreaterThan(0);

    const restored = openVaultDb();
    importVaultExport(restored, artifact);
    for (const entity of commonsEntities) {
      const physical = entity.replace(".", "_");
      expect(
        restored.vault.prepare(`SELECT COUNT(*) AS n FROM "${physical}"`).get(),
        entity
      ).toMatchObject({ n: expect.any(Number) });
      expect(
        (
          restored.vault
            .prepare(`SELECT COUNT(*) AS n FROM "${physical}"`)
            .get() as { n: number }
        ).n,
        entity
      ).toBeGreaterThan(0);
    }
    restored.close();
  });

  test("a delivered fulfillment's delivery memory survives export and restore", () => {
    const deliveredAt = "2026-08-11T09:30:00.000Z";
    const subjectId = uuidv7();
    const created = createShareGrant(db.vault, {
      audience: { kind: "party", id: boot.ownerPartyId },
      subjectType: "core.document",
      subjectId,
      capability: "view",
      grantedAt: deliveredAt,
      grantedBy: boot.ownerPartyId,
    });
    assert(created.outcome === "created");
    setFulfillmentState(db.vault, {
      grantId: created.grant.grantId,
      peerVaultId: "portable-audience-vault",
      state: "delivered",
      updatedAt: deliveredAt,
    });
    setFulfillmentState(db.vault, {
      grantId: created.grant.grantId,
      peerVaultId: "portable-audience-vault",
      state: "syncing",
      updatedAt: "2026-08-11T10:00:00.000Z",
    });

    const { artifact } = gw.exportVault(owner);
    expect(artifact.tables["share.fulfillment"]).toContainEqual(
      expect.objectContaining({
        state: "syncing",
        delivered_at: deliveredAt,
      })
    );

    const restored = openVaultDb();
    importVaultExport(restored, artifact);
    expect(
      restored.vault
        .prepare(
          `SELECT state, delivered_at FROM share_fulfillment
             WHERE grant_id = ? AND peer_vault_id = 'portable-audience-vault'`
        )
        .get(created.grant.grantId)
    ).toMatchObject({ state: "syncing", delivered_at: deliveredAt });
    restored.close();
  });

  test("an Assist refresh capability survives export and restore (issue #865)", () => {
    const connectionId = uuidv7();
    const capability = "cap-must-survive-export";
    db.vault
      .prepare(
        `INSERT INTO sync_connection
         (connection_id, kind, label, status, trust, created_at)
         VALUES (?, 'gmail', 'assist-export', 'active', 'staged', ?)`
      )
      .run(connectionId, "2026-08-26T00:00:00.000Z");
    db.vault
      .prepare(
        `INSERT INTO sync_connection_credential
         (connection_id, cred_kind, oauth_mode, provider, refresh_token,
          refresh_capability, allowed_hosts, updated_at)
         VALUES (?, 'oauth2', 'assist', 'google', 'sealed:v1:token',
          ?, '[]', ?)`
      )
      .run(connectionId, capability, "2026-08-26T00:00:00.000Z");

    const { artifact } = gw.exportVault(owner);
    expect(artifact.tables["sync.connection_credential"]).toContainEqual(
      expect.objectContaining({
        connection_id: connectionId,
        refresh_capability: capability,
      })
    );

    const restored = openVaultDb();
    importVaultExport(restored, artifact);
    expect(
      restored.vault
        .prepare(
          `SELECT refresh_capability FROM sync_connection_credential
           WHERE connection_id = ?`
        )
        .get(connectionId)
    ).toMatchObject({ refresh_capability: capability });
    restored.close();
  });

  test("tampered artifact is rejected by hash verification", () => {
    seedLife();
    const { artifact } = gw.exportVault(owner);
    const tampered = structuredClone(artifact);
    const events = tampered.tables["core.event"];
    if (!events?.[0]) throw new Error("expected an event");
    events[0]["summary"] = "Rewritten history";
    const fresh = openVaultDb();
    expect(() => importVaultExport(fresh, tampered)).toThrow(/hash mismatch/u);
    fresh.close();
  });

  test("import refuses a non-fresh vault", () => {
    seedLife();
    const { artifact } = gw.exportVault(owner);
    expect(() => importVaultExport(db, artifact)).toThrow(/not a fresh vault/u);
  });

  test("a poisoned row on one table is skipped, not fatal to the whole export (§4.3 hardening)", () => {
    seedLife();
    const originalPrepare = db.vault.prepare.bind(db.vault);
    const spy = vi
      .spyOn(db.vault, "prepare")
      .mockImplementation(
        (sql: string): ReturnType<typeof db.vault.prepare> => {
          if (sql.includes('FROM "core_place"')) {
            throw new Error(
              "Value is too large to be represented as a JavaScript number"
            );
          }
          return originalPrepare(sql);
        }
      );

    const { artifact } = gw.exportVault(owner);
    spy.mockRestore();

    expect(artifact.skippedTables?.map((s) => s.entity)).toContain(
      "core.place"
    );
    expect(
      artifact.skippedTables?.find((s) => s.entity === "core.place")?.error
    ).toContain("too large");
    expect(artifact.tables["core.place"]).toBeUndefined();
    expect(artifact.tables["core.event"]?.length).toBeGreaterThan(0);
    expect(artifact.tables["core.party"]?.length).toBeGreaterThan(0);

    expect(artifact.verifyHash).toBe(sha256Hex(canonicalJson(artifact.tables)));

    const restored = openVaultDb();
    expect(() => importVaultExport(restored, artifact)).not.toThrow();
    const places = restored.vault
      .prepare("SELECT count(*) AS n FROM core_place")
      .get() as {
      n: number;
    };
    expect(places.n).toBe(0);
    restored.close();
  });
});
