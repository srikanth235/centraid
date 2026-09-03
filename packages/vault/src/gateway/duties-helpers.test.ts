// Direct unit coverage for standing-duty helpers (#545).

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault, createGrant, enrollApp } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { uuidv7 } from "../ids.js";
import {
  admitImportedRow,
  resolveHandle,
  revokeGrantCascade,
  sweepLifecycle,
} from "./duties.js";
import type { Identity } from "./types.js";

let db: VaultDb;
let boot: BootstrapResult;
let owner: Identity;

describe("duties-helpers", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    owner = {
      kind: "owner-device",
      callerId: boot.deviceId,
      provAgentKind: "owner",
      partyId: boot.ownerPartyId,
      mayAct: true,
    };
  });

  test("admitImportedRow inserts once and dedupes on the external id column", () => {
    const now = new Date().toISOString();
    let inserts = 0;
    const first = admitImportedRow(
      db,
      owner,
      "core.event",
      { physical: "core_event", column: "ical_uid" },
      "evt-1@example.com",
      () => {
        inserts += 1;
        const id = uuidv7();
        db.vault
          .prepare(
            `INSERT INTO core_event
             (event_id, ical_uid, summary, description, dtstart, dtend, start_tz, rrule, status, sequence, recurrence_semantics, created_at, updated_at)
           VALUES (?, 'evt-1@example.com', 'Meet', NULL, ?, NULL, NULL, NULL, 'confirmed', 0, 'floating', ?, ?)`
          )
          .run(id, now, now, now);
        return id;
      },
      "ics"
    );
    expect(first).toBeTruthy();
    expect(inserts).toBe(1);
    const second = admitImportedRow(
      db,
      owner,
      "core.event",
      { physical: "core_event", column: "ical_uid" },
      "evt-1@example.com",
      () => {
        inserts += 1;
        return uuidv7();
      },
      "ics"
    );
    expect(second).toBeNull();
    expect(inserts).toBe(1);
    const prov = db.audit
      .prepare(
        `SELECT count(*) AS n FROM access_provenance
        WHERE entity_type = 'core.event' AND prov_activity = 'import.ics'`
      )
      .get() as { n: number };
    expect(prov.n).toBe(1);
  });

  test("resolveHandle reads reach from channels and identity keys from the register", () => {
    const now = new Date().toISOString();
    const past = "2020-01-01T00:00:00.000Z";
    // A channel has no validity window: a member DELETES an address they no
    // longer answer at (#883).
    db.vault
      .prepare(
        `INSERT INTO social_contact_channel
         (channel_id, party_id, kind, label, value, normalized_value,
          is_preferred, created_at, updated_at)
       VALUES (?, ?, 'email', 'home', 'priya@example.com', 'priya@example.com',
               1, ?, ?)`
      )
      .run(uuidv7(), boot.ownerPartyId, now, now);
    expect(resolveHandle(db, "email", "priya@example.com")).toBe(
      boot.ownerPartyId
    );

    const other = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES (?, 'person', 'Expired', ?, ?)`
      )
      .run(other, now, now);
    // An EXPIRED identity key still reads as expired.
    db.vault
      .prepare(
        `INSERT INTO core_party_identifier
         (identifier_id, party_id, scheme, value, label, is_primary, valid_from, valid_to)
       VALUES (?, ?, 'handle', '@gone', NULL, 1, ?, ?)`
      )
      .run(uuidv7(), other, past, past);
    expect(resolveHandle(db, "handle", "@gone")).toBeNull();
    expect(resolveHandle(db, "email", "gone@example.com")).toBeNull();
    expect(resolveHandle(db, "tel", "+10000000000")).toBeNull();
  });

  test("revokeGrantCascade marks the grant revoked and drops parked via callback", () => {
    const app = enrollApp(db, { name: "duty-app" });
    const grantId = createGrant(db, {
      appId: app.appId,
      purposeConceptId: boot.concepts["dpv:ServiceProvision"] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [{ schema: "schedule", verbs: "read" }],
    });
    let dropped = 0;
    const result = revokeGrantCascade(db, owner, grantId, () => {
      dropped = 3;
      return 3;
    });
    expect(result).toMatchObject({
      grantId,
      appId: "duty-app",
      parkedDropped: 3,
    });
    expect(dropped).toBe(3);
    const grant = db.vault
      .prepare("SELECT status, revoked_at FROM access_grant WHERE grant_id = ?")
      .get(grantId) as { status: string; revoked_at: string | null };
    expect(grant.status).toBe("revoked");
    expect(grant.revoked_at).toBeTruthy();
    expect(() =>
      revokeGrantCascade(db, owner, "missing-grant", () => 0)
    ).toThrow(/no grant/u);
  });

  test("sweepLifecycle returns a zeroed result shape on a clean vault", () => {
    const result = sweepLifecycle(db, owner);
    expect(result).toMatchObject({
      grantsExpired: 0,
      contentPurged: 0,
      assetsPurged: 0,
      notesPurged: 0,
      documentsPurged: 0,
      domainRowsPurged: 0,
      retentionDeleted: 0,
      blobsReclaimed: 0,
    });
    expect(result.receiptId.length).toBeGreaterThan(10);
  });
});
