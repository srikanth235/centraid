// core.merge_party (#290): folding a duplicate re-points every reference —
// engine FKs, polymorphic pairs, identifiers with primary demotion, the
// external-id map — and deletes the duplicate.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { Gateway } from "../gateway/gateway.js";
import { createGateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";
import { registerPartyCommands } from "./parties.js";
import { registerPeopleCommands } from "./people.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

describe("merge", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerPartyCommands(gw);
    registerPeopleCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  function addParty(name: string, email?: string): string {
    const outcome = gw.invoke(owner, {
      command: "core.add_party",
      input: {
        display_name: name,
        ...(email ? { identifiers: [{ scheme: "email", value: email }] } : {}),
      },
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { party_id: string } }).output.party_id;
  }

  function merge(survivor: string, merged: string): InvokeOutcome {
    return gw.invoke(owner, {
      command: "core.merge_party",
      input: { survivor_party_id: survivor, merged_party_id: merged },
    });
  }

  test("merge re-points reach and keys (preferred demoted), FK rows and the map; duplicate gone", () => {
    const john = addParty("John Smith", "john@work.example");
    const dupe = addParty("J. Smith", "jsmith@personal.example");
    db.vault
      .prepare(
        `INSERT INTO schedule_task
         (task_id, owner_party_id, title, status, priority)
       VALUES ('task-1', ?, 'quarterly catch-up', 'needs-action', 0)`
      )
      .run(dupe);
    db.vault
      .prepare(
        `INSERT INTO sync_connection (connection_id, kind, label, principal, status, trust, created_at)
       VALUES ('c1', 'file.vcf', 'contacts.vcf', NULL, 'active', 'staged', '2026-07-06T00:00:00Z')`
      )
      .run();
    db.vault
      .prepare(
        `INSERT INTO sync_external_entity (map_id, connection_id, external_id, target_type, target_id, content_hash, first_seen_at, last_seen_at, gone_upstream)
       VALUES ('m1', 'c1', 'email:jsmith@personal.example', 'core.party', ?, 'h', '2026-07-06', '2026-07-06', 0)`
      )
      .run(dupe);

    const outcome = merge(john, dupe);
    expect(outcome.status).toBe("executed");
    const output = (outcome as { output: { repointed: number } }).output;
    expect(output.repointed).toBeGreaterThanOrEqual(3); // identifier + task + map

    // Duplicate gone; references live on the survivor.
    expect(
      db.vault
        .prepare("SELECT 1 AS x FROM core_party WHERE party_id = ?")
        .get(dupe)
    ).toBeUndefined();
    // A channel merges by the register's rule: the survivor keeps its
    // preferred slot and the incoming address is demoted, never dropped.
    const ids = db.vault
      .prepare(
        `SELECT normalized_value AS value, is_preferred AS is_primary
           FROM social_contact_channel WHERE party_id = ? ORDER BY value`
      )
      .all(john);
    expect(ids.map((row) => ({ ...row }))).toStrictEqual([
      { value: "john@work.example", is_primary: 1 },
      { value: "jsmith@personal.example", is_primary: 0 }, // demoted, never lost
    ]);
    const moved = db.vault
      .prepare(
        "SELECT count(*) AS n FROM schedule_task WHERE owner_party_id = ?"
      )
      .get(john) as { n: number };
    expect(moved.n).toBe(1);
    const map = db.vault
      .prepare("SELECT target_id FROM sync_external_entity WHERE map_id = ?")
      .get("m1") as { target_id: string };
    expect(map.target_id).toBe(john);
  });

  function grantTo(
    authorityId: string,
    partyId: string,
    subjectId: string
  ): void {
    db.vault
      .prepare(
        `INSERT INTO share_authority
           (authority_id, principal_kind, principal_id, subject_type, subject_id,
            verb, duration, decision, granted_at, granted_by)
         VALUES (?, 'person', ?, 'core.document', ?, 'view', 'standing',
                 'granted', '2026-08-01T00:00:00Z', ?)`
      )
      .run(authorityId, partyId, subjectId, boot.ownerPartyId);
  }

  function principalOf(authorityId: string): {
    principal_id: string;
    revoked_at: string | null;
  } {
    return db.vault
      .prepare(
        "SELECT principal_id, revoked_at FROM share_authority WHERE authority_id = ?"
      )
      .get(authorityId) as { principal_id: string; revoked_at: string | null };
  }

  // The plane carries no FK on `principal_id` and says 'person', not
  // 'core.party', so neither the FK walk nor the poly registry reaches it. Left
  // behind, the grant names a deleted row and the share stops being delivered.
  test("a standing grant to the duplicate follows the survivor", () => {
    const asha = addParty("Asha Rao");
    const dupe = addParty("Asha R.");
    grantTo("auth-1", dupe, "doc-1");

    expect(merge(asha, dupe).status).toBe("executed");

    const grant = principalOf("auth-1");
    expect(grant.principal_id).toBe(asha);
    expect(grant.revoked_at).toBeNull();
  });

  // `share_authority_live_answer` covers LIVE rows only, so the loser is
  // revoked before it re-points: the answer survives as history rather than
  // being deleted, and the survivor's own answer stays the live one.
  test("a colliding answer is revoked, not dropped, and still stops naming the deleted party", () => {
    const asha = addParty("Asha Rao");
    const dupe = addParty("Asha R.");
    grantTo("auth-keep", asha, "doc-1");
    grantTo("auth-dupe", dupe, "doc-1");

    expect(merge(asha, dupe).status).toBe("executed");

    const kept = principalOf("auth-keep");
    expect(kept.principal_id).toBe(asha);
    expect(kept.revoked_at).toBeNull();
    const loser = principalOf("auth-dupe");
    expect(loser.principal_id).toBe(asha);
    expect(loser.revoked_at).not.toBeNull();
  });

  function inviteTo(
    invitationId: string,
    grantId: string,
    partyId: string
  ): void {
    db.vault
      .prepare(
        `INSERT INTO share_commons_invitation
           (invitation_id, grant_id, steward_vault_id, member_party_id,
            capability, container_type, container_id, current_size_bytes,
            status, created_at)
         VALUES (?, ?, 'vault-steward', ?, 'read', 'tally.group', 'group-1', 0,
                 'pending', '2026-08-01T00:00:00Z')`
      )
      .run(invitationId, grantId, partyId);
  }

  // Same shape as the authority principal, different answer on collision: an
  // invitation is machinery, not a standing answer, so the duplicate ask is
  // dropped rather than kept as history.
  test("a pending invitation follows the merge, and a duplicate ask is dropped", () => {
    const asha = addParty("Asha Rao");
    const dupe = addParty("Asha R.");
    inviteTo("inv-follow", "grant-a", dupe);
    inviteTo("inv-keep", "grant-b", asha);
    inviteTo("inv-dupe", "grant-b", dupe);

    expect(merge(asha, dupe).status).toBe("executed");

    const invitations = db.vault
      .prepare(
        `SELECT invitation_id, grant_id, member_party_id
           FROM share_commons_invitation ORDER BY invitation_id`
      )
      .all() as { invitation_id: string; member_party_id: string }[];
    expect(invitations.map((row) => row.invitation_id)).toStrictEqual([
      "inv-follow",
      "inv-keep",
    ]);
    for (const row of invitations) expect(row.member_party_id).toBe(asha);
  });

  test("merging the vault owner away is refused by contract", () => {
    const other = addParty("Someone Else");
    const outcome = merge(other, boot.ownerPartyId);
    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toMatch(
      /merged_is_not_the_owner/u
    );
  });

  test("self-merge is refused by contract", () => {
    const p = addParty("Solo");
    const outcome = merge(p, p);
    expect(outcome.status).toBe("failed");
  });

  function addPerson(
    name: string,
    extras?: { cadence_days: number; avatar_color?: string }
  ): string {
    const outcome = gw.invoke(owner, {
      command: "people.add_person",
      input: { display_name: name, cadence_days: 0, ...extras },
    });
    expect(outcome.status).toBe("executed");
    return (outcome as { output: { party_id: string } }).output.party_id;
  }

  test("merge keeps the folded-in cadence, last-contacted, and colour (#864)", () => {
    const keep = addPerson("Asha Rao");
    const dupe = addPerson("Asha R.", {
      cadence_days: 14,
      avatar_color: "#7C5BD9",
    });
    expect(
      gw.invoke(owner, {
        command: "people.log_interaction",
        input: { party_id: dupe, kind: "Call" },
      }).status
    ).toBe("executed");
    const touched = (
      db.vault
        .prepare(
          "SELECT last_contacted_at FROM people_profile WHERE party_id = ?"
        )
        .get(dupe) as { last_contacted_at: string }
    ).last_contacted_at;

    const outcome = merge(keep, dupe);
    expect(outcome.status).toBe("executed");
    const folded = db.vault
      .prepare(
        `SELECT cadence_days, last_contacted_at, avatar_color
           FROM people_profile WHERE party_id = ?`
      )
      .get(keep) as {
      cadence_days: number;
      last_contacted_at: string | null;
      avatar_color: string | null;
    };
    expect(folded).toMatchObject({
      cadence_days: 14,
      last_contacted_at: touched,
      avatar_color: "#7C5BD9",
    });
    expect(
      db.vault
        .prepare("SELECT 1 AS x FROM people_profile WHERE party_id = ?")
        .get(dupe)
    ).toBeUndefined();
  });

  // ── The convergence sweep (issue #310 C4) ──────────────────────────────

  test("find_duplicate_parties reports name collisions with identifier context", () => {
    const now = new Date().toISOString();
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('dup-a', 'person', 'J. Smith', ?, ?), ('dup-b', 'person', 'j. smith', ?, ?),
              ('solo', 'person', 'Unique Name', ?, ?)`
      )
      .run(now, now, now, now, now, now);
    db.vault
      .prepare(
        `INSERT INTO social_contact_channel
           (channel_id, party_id, kind, value, normalized_value, is_preferred,
            created_at, updated_at)
       VALUES ('dc-1', 'dup-a', 'email', 'js@work.example', 'js@work.example', 1, ?, ?),
              ('dc-2', 'dup-b', 'phone', '+15550001', '+15550001', 1, ?, ?)`
      )
      .run(now, now, now, now);
    const outcome = gw.invoke(owner, {
      command: "core.find_duplicate_parties",
      input: {},
    });
    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") return;
    const candidates = (
      outcome.output as { candidates: Record<string, unknown>[] }
    ).candidates;
    const pair = candidates.find(
      (c) => c.party_a === "dup-a" && c.party_b === "dup-b"
    );
    expect(pair).toBeDefined();
    expect(String(pair?.a_identifiers)).toContain("email:js@work.example");
    expect(String(pair?.b_identifiers)).toContain("phone:+15550001");
    expect(
      candidates.some((c) => c.party_a === "solo" || c.party_b === "solo")
    ).toBe(false);
  });
});
