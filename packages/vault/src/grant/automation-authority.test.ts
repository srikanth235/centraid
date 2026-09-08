import { afterEach, describe, expect, test } from "vitest";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import {
  automationAnswers,
  automationSubjectsOf,
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
});
