import { afterEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import { ensureAgentEnrolled } from "../host.js";
import { uuidv7 } from "../ids.js";
import {
  automationAnswers,
  automationSubjectsOf,
  backfillAutomationAnswers,
  recordAutomationAnswers,
  revokeAutomationAnswers,
} from "./automation-authority.js";
import type { AutomationScope } from "./automation-authority.js";

const databases: Array<ReturnType<typeof openVaultDb>> = [];

function freshVault(): {
  db: ReturnType<typeof openVaultDb>;
  boot: ReturnType<typeof bootstrapVault>;
} {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Automation owner" });
  databases.push(db);
  return { db, boot };
}

describe("grant/automation-authority", () => {
  afterEach(() => {
    for (const db of databases.splice(0)) db.close({ skipOptimize: true });
  });

  test("maps pack and entity scopes to unique read and act subjects", () => {
    expect(
      automationSubjectsOf([
        { schema: "schedule", verbs: "read+act" },
        { schema: "core", table: "party", verbs: "read" },
        { schema: "schedule", verbs: "read" },
        { schema: "locker", table: "item", verbs: "reveal" },
        { schema: "ignored", verbs: "unknown" as AutomationScope["verbs"] },
        { schema: "media", verbs: "act" },
      ])
    ).toStrictEqual([
      { subjectType: "agent.pack", subjectId: "schedule", verb: "read" },
      { subjectType: "agent.pack", subjectId: "schedule", verb: "act" },
      { subjectType: "core.entity", subjectId: "core.party", verb: "read" },
      { subjectType: "agent.pack", subjectId: "media", verb: "act" },
    ]);
  });

  test("records, queries, replaces, and revokes answers", () => {
    const { db, boot } = freshVault();
    const owner = boot.ownerPartyId;
    const subject = {
      subjectType: "agent.pack",
      subjectId: "schedule",
      verb: "read" as const,
    };

    expect(
      recordAutomationAnswers(db.vault, {
        principalId: "digest",
        ownerPartyId: owner,
        subjects: [subject],
        decision: "granted",
        now: "2026-09-04T00:00:00.000Z",
      })
    ).toBe(1);
    expect(automationAnswers(db.vault, "digest")).toMatchObject([
      { ...subject, decision: "granted", principalId: "digest" },
    ]);
    expect(automationAnswers(db.vault)).toHaveLength(1);

    expect(
      recordAutomationAnswers(db.vault, {
        principalId: "digest",
        ownerPartyId: owner,
        subjects: [subject],
        decision: "granted",
        now: "2026-09-04T00:01:00.000Z",
      })
    ).toBe(0);
    expect(
      recordAutomationAnswers(db.vault, {
        principalId: "digest",
        ownerPartyId: owner,
        subjects: [subject],
        decision: "declined",
        now: "2026-09-04T00:02:00.000Z",
      })
    ).toBe(1);
    expect(automationAnswers(db.vault, "digest")).toMatchObject([
      { ...subject, decision: "declined" },
    ]);
    expect(
      db.vault
        .prepare(
          "SELECT count(*) AS n FROM share_authority WHERE principal_id = ? AND revoked_at IS NOT NULL"
        )
        .get("digest")
    ).toMatchObject({ n: 1 });

    expect(
      revokeAutomationAnswers(db.vault, "digest", "2026-09-04T00:03:00.000Z")
    ).toBe(1);
    expect(automationAnswers(db.vault, "digest")).toStrictEqual([]);
    expect(
      revokeAutomationAnswers(db.vault, "digest", "2026-09-04T00:04:00.000Z")
    ).toBe(0);
  });

  test("backfills legacy grants and tombstones, excluding the assistant", () => {
    const { db, boot } = freshVault();
    const digest = ensureAgentEnrolled(db, "digest");
    const assistant = ensureAgentEnrolled(db, "_assistant");
    const purposeConceptId = boot.concepts["dpv:ServiceProvision"];
    if (!purposeConceptId) throw new Error("missing test purpose concept");
    const grantId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO access_grant
           (grant_id, grantee_party_id, purpose_concept_id, granted_by_party_id,
            granted_at, expires_at, revoked_at, status)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active')`
      )
      .run(
        grantId,
        digest.partyId,
        purposeConceptId,
        boot.ownerPartyId,
        "2026-09-04T00:00:00.000Z"
      );
    const scope = db.vault.prepare(
      `INSERT INTO access_grant_scope
         (scope_id, grant_id, entity, verbs, row_filter_json, field_mask_json)
       VALUES (?, ?, ?, ?, NULL, NULL)`
    );
    scope.run(uuidv7(), grantId, "schedule", "read+act");
    scope.run(uuidv7(), grantId, "core.party", "read");
    scope.run(uuidv7(), grantId, "locker.item", "reveal");
    db.vault
      .prepare(
        `INSERT INTO access_scope_tombstone
           (tombstone_id, grantee_party_id, entity, verbs, row_filter_json,
            field_mask_json, revoked_at)
         VALUES (?, ?, 'media', 'read', NULL, NULL, ?)`
      )
      .run(uuidv7(), digest.partyId, "2026-09-04T00:00:00.000Z");
    db.vault
      .prepare(
        `INSERT INTO access_grant
           (grant_id, grantee_party_id, purpose_concept_id, granted_by_party_id,
            granted_at, expires_at, revoked_at, status)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 'active')`
      )
      .run(
        uuidv7(),
        assistant.partyId,
        purposeConceptId,
        boot.ownerPartyId,
        "2026-09-04T00:00:00.000Z"
      );

    expect(
      backfillAutomationAnswers(
        db.vault,
        boot.ownerPartyId,
        "2026-09-04T00:05:00.000Z"
      )
    ).toStrictEqual({ granted: 3, declined: 1 });
    expect(automationAnswers(db.vault, "digest")).toHaveLength(4);
    expect(automationAnswers(db.vault, "_assistant")).toStrictEqual([]);
    expect(
      backfillAutomationAnswers(
        db.vault,
        boot.ownerPartyId,
        "2026-09-04T00:06:00.000Z"
      )
    ).toStrictEqual({ granted: 0, declined: 0 });
  });
});
