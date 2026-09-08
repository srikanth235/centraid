// THE CENSUS BY ROLE, HELD TO THE LIVE SCHEMA (#996, ruling R22).
//
// R22 asks for deletion declared by relationship role "beside each reference,
// with the purge behaviour tested per role; the FK census by referenced table
// becomes a census by role". Two halves, both here:
//
//   1. MECHANICAL. Every foreign key in the live schema onto a roled parent has
//      a declaration, every declaration names a live key, and every declared
//      role's `ON DELETE` rule is the one the role means. A reference that
//      arrives without a role fails; a delete rule that changes without its
//      role changing fails with it.
//   2. BEHAVIOURAL. One purge, driven through the real sweep, watched per role:
//      an owned child goes, derived output goes, an attribution survives
//      unattributed, and a participation or a durable record REFUSES the purge
//      with the rows that blocked it named.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerPartyCommands } from "../commands/parties.js";
import { registerPeopleCommands } from "../commands/people.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import {
  DELETION_ROLES,
  deletionRoleOf,
  ROLE_ON_DELETE,
  ROLED_PARENTS,
  referencesInRole,
  roleCensus,
} from "./deletion-roles.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

interface LiveReference {
  table: string;
  column: string;
  parent: string;
  onDelete: string;
}

/** Every foreign key in the live schema onto one of the roled parents. */
function liveReferences(vault: VaultDb["vault"]): LiveReference[] {
  const tables = (
    vault
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  const found: LiveReference[] = [];
  for (const table of tables) {
    const keys = vault
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
      .all() as { table: string; from: string; on_delete: string }[];
    for (const key of keys) {
      if (!ROLED_PARENTS.includes(key.table)) continue;
      found.push({
        table,
        column: key.from,
        parent: key.table,
        onDelete: key.on_delete,
      });
    }
  }
  return found;
}

describe("deletion by relationship role", () => {
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

  afterEach(() => {
    db.close();
  });

  // ── 1. The census ───────────────────────────────────────────────────────

  test("every live reference onto a roled parent is declared", () => {
    const undeclared = liveReferences(db.vault)
      .filter((reference) => !deletionRoleOf(reference.table, reference.column))
      .map((reference) => `${reference.table}.${reference.column}`);
    expect(
      undeclared,
      "references with no declared deletion role"
    ).toStrictEqual([]);
  });

  test("every declaration names a reference the schema still has", () => {
    const live = new Set(
      liveReferences(db.vault).map(
        (reference) => `${reference.table}.${reference.column}`
      )
    );
    const stale = DELETION_ROLES.filter(
      (entry) => !live.has(`${entry.table}.${entry.column}`)
    ).map((entry) => `${entry.table}.${entry.column}`);
    expect(stale, "declared roles for references that are gone").toStrictEqual(
      []
    );
  });

  test("every role's delete rule is the one the role means", () => {
    const disagreeing = liveReferences(db.vault)
      .map((reference) => ({
        reference,
        declared: deletionRoleOf(reference.table, reference.column),
      }))
      .filter(({ reference, declared }) => {
        if (!declared) return false;
        // A role the SWEEP carries out is not the key's job; the declaration
        // says so, and the key's own rule is whatever the parent needs.
        if (declared.enforcedBy === "sweep") return false;
        return (
          reference.onDelete !== ROLE_ON_DELETE[declared.role] ||
          reference.onDelete !== declared.onDelete
        );
      })
      .map(
        ({ reference, declared }) =>
          `${reference.table}.${reference.column}: ${declared!.role} means ${ROLE_ON_DELETE[declared!.role]}, schema says ${reference.onDelete}`
      );
    expect(disagreeing).toStrictEqual([]);
  });

  test("every declaration carries a reason, and the census is not empty", () => {
    for (const entry of DELETION_ROLES) {
      expect(
        entry.why.length,
        `${entry.table}.${entry.column} has no reason`
      ).toBeGreaterThan(20);
      expect(ROLED_PARENTS).toContain(entry.parent);
    }
    const census = roleCensus();
    for (const [role, count] of Object.entries(census)) {
      expect(count, `no reference stands in role ${role}`).toBeGreaterThan(0);
    }
    expect(
      Object.values(census).reduce((total, count) => total + count, 0)
    ).toBe(DELETION_ROLES.length);
  });

  // ── 2. The behaviour, one role at a time ────────────────────────────────

  function addPerson(name: string): string {
    const outcome = gw.invoke(owner, {
      command: "people.add_person",
      input: { display_name: name, cadence_days: 0 },
    });
    expect(outcome.status, JSON.stringify(outcome)).toBe("executed");
    return (outcome as { output: { party_id: string } }).output.party_id;
  }

  function trashAndLapse(partyId: string): void {
    db.vault
      .prepare(
        `UPDATE people_profile SET deleted_at = '2020-01-01T00:00:00Z',
            purge_at = '2020-01-02T00:00:00Z' WHERE party_id = ?`
      )
      .run(partyId);
  }

  test("owned-child: a person's identifiers and dates go with them", () => {
    const partyId = addPerson("Mira");
    expect(
      gw.invoke(owner, {
        command: "people.add_important_date",
        input: { party_id: partyId, label: "birthday", month_day: "03-01" },
      }).status
    ).toBe("executed");
    db.vault
      .prepare(
        `INSERT INTO core_party_identifier
           (identifier_id, party_id, scheme, value, is_primary, valid_from)
         VALUES ('mira-handle', ?, 'handle', '@mira', 1, '2020-01-01T00:00:00Z')`
      )
      .run(partyId);
    trashAndLapse(partyId);
    gw.sweep(owner);
    for (const table of ["core_party_identifier", "people_important_date"]) {
      const left = db.vault
        .prepare(`SELECT count(*) AS n FROM "${table}" WHERE party_id = ?`)
        .get(partyId) as { n: number };
      expect(left.n, `${table} survived an owned-child purge`).toBe(0);
    }
    const party = db.vault
      .prepare("SELECT count(*) AS n FROM core_party WHERE party_id = ?")
      .get(partyId) as { n: number };
    expect(party.n).toBe(0);
    // Every one of those references is declared as an owned child, and one of
    // them is carried out by the sweep rather than by the key.
    expect(deletionRoleOf("core_party_identifier", "party_id")?.role).toBe(
      "owned-child"
    );
    expect(
      deletionRoleOf("core_party_identifier", "party_id")?.enforcedBy
    ).toBe("sweep");
  });

  test("participation and durable-record: the purge is refused, and says by what", () => {
    const partyId = addPerson("Ravi");
    // A participation: being on a calendar the member owns.
    db.vault
      .prepare(
        `INSERT INTO schedule_calendar (calendar_id, owner_party_id, name, default_tz, visibility, created_at)
         VALUES ('cal-ravi', ?, 'Ravi', 'Etc/UTC', 'private', '2020-01-01T00:00:00Z')`
      )
      .run(partyId);
    trashAndLapse(partyId);
    // The sweep does not die on a refusal: it records a NAMED skip, which is
    // the whole point of the role — a refusal a member cannot act on is
    // indistinguishable from a bug.
    const result = gw.sweep(owner);
    const refusal = result.skipped.find(
      (skip) => skip.entity === "people.profile"
    );
    expect(refusal, "the refused purge is named").toBeDefined();
    expect(refusal!.reason).toMatch(/cannot be erased while/u);
    expect(refusal!.reason).toContain("schedule_calendar");
    const party = db.vault
      .prepare("SELECT count(*) AS n FROM core_party WHERE party_id = ?")
      .get(partyId) as { n: number };
    expect(party.n, "a refused purge leaves the person").toBe(1);
    expect(deletionRoleOf("schedule_calendar", "owner_party_id")?.role).toBe(
      "participation"
    );
  });

  test("attribution: the row survives, unattributed", () => {
    const partyId = addPerson("Sena");
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, content_uri, sha256, byte_size, creator_party_id, created_at)
         VALUES ('sena-bytes', 'file:///sena', ?, 4, ?, '2020-01-01T00:00:00Z')`
      )
      .run("11".repeat(32), partyId);
    trashAndLapse(partyId);
    gw.sweep(owner);
    const content = db.vault
      .prepare(
        "SELECT creator_party_id FROM core_content_item WHERE content_id = 'sena-bytes'"
      )
      .get() as { creator_party_id: string | null } | undefined;
    expect(content, "the bytes outlive their creator").toBeDefined();
    expect(content!.creator_party_id).toBeNull();
    expect(deletionRoleOf("core_content_item", "creator_party_id")?.role).toBe(
      "attribution"
    );
  });

  test("derived: rebuildable output goes with the bytes, and is told apart from an owned child", () => {
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, content_uri, sha256, byte_size, created_at)
         VALUES ('bytes-1', 'file:///b', ?, 4, '2020-01-01T00:00:00Z')`
      )
      .run("22".repeat(32));
    db.vault
      .prepare(
        `INSERT INTO core_content_text (content_id, body_text, decoder, byte_size)
         VALUES ('bytes-1', 'hello', 'test', 5)`
      )
      .run();
    db.vault
      .prepare("DELETE FROM core_content_item WHERE content_id = 'bytes-1'")
      .run();
    const text = db.vault
      .prepare(
        "SELECT count(*) AS n FROM core_content_text WHERE content_id = 'bytes-1'"
      )
      .get() as { n: number };
    expect(text.n, "decoded text is recomputable and goes with the bytes").toBe(
      0
    );
    expect(deletionRoleOf("core_content_text", "content_id")?.role).toBe(
      "derived"
    );
    // Both cascade; only one of them can be regenerated, and the declaration
    // is where that difference is written down (R22).
    expect(
      deletionRoleOf("core_content_representation", "content_id")?.role
    ).toBe("owned-child");
    expect(referencesInRole("derived").length).toBeGreaterThan(0);
    expect(referencesInRole("owned-child").length).toBeGreaterThan(0);
  });
});
