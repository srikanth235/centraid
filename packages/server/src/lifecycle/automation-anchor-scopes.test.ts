import { afterEach, describe, expect, test } from "vitest";

import {
  createGateway,
  createGrant,
  bootstrapVault,
  ensureAppEnrolled,
  openVaultDb,
  purposeConceptId,
} from "@centraid/vault";
import type { Credential } from "@centraid/vault";

import {
  AutomationAnchorError,
  resolveAutomationAnchors,
  scopesForAutomationAnchors,
} from "./automation-anchor-scopes.js";
import type { AnchorVaultReads } from "./automation-anchor-scopes.js";

const cleanups: Array<() => void> = [];
describe("automation-anchor-scopes", () => {
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  function anchoredTaskFixture() {
    const db = openVaultDb();
    cleanups.push(() => db.close());
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    const insertTask = db.vault.prepare(
      `INSERT INTO schedule_task
       (task_id, owner_party_id, title, description, status, priority)
     VALUES (?, ?, ?, ?, 'needs-action', 5)`
    );
    insertTask.run(
      "task-anchored",
      boot.ownerPartyId,
      "Prepare quarterly report today",
      "Sensitive detail"
    );
    insertTask.run(
      "task-other",
      boot.ownerPartyId,
      "Prepare another report today",
      "Must remain hidden"
    );
    const relation = db.vault
      .prepare("SELECT concept_id FROM core_concept LIMIT 1")
      .get() as {
      concept_id: string;
    };
    db.vault
      .prepare(
        `INSERT INTO core_link
       (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
        valid_from, valid_to, asserted_by, provenance_id)
       VALUES ('link-1', 'schedule.task', 'task-anchored', 'core.party', ?,
               ?, '2026-07-25T00:00:00.000Z', NULL, 'owner', NULL)`
      )
      .run(boot.ownerPartyId, relation.concept_id);
    db.vault
      .prepare(
        `INSERT INTO core_link_anchor (anchor_id, link_id, selector_json, created_at)
       VALUES ('anchor-1', 'link-1', ?, '2026-07-25T00:00:00.000Z')`
      )
      .run(
        JSON.stringify({
          exact: "quarterly report",
          prefix: "Prepare ",
          suffix: " today",
          start: 8,
        })
      );
    const credential: Credential = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    const vault: AnchorVaultReads = { gateway: createGateway(db), credential };
    return { boot, db, vault };
  }

  test("anchor token resolves to its trusted row, field, and span", () => {
    const { vault } = anchoredTaskFixture();
    expect(
      resolveAutomationAnchors(
        vault,
        "Notify about @[core.link_anchor/anchor-1]."
      )
    ).toStrictEqual([
      expect.objectContaining({
        anchorId: "anchor-1",
        linkId: "link-1",
        sourceType: "schedule.task",
        sourceId: "task-anchored",
        sourceField: "title",
        targetType: "core.party",
        selector: expect.objectContaining({
          exact: "quarterly report",
          start: 8,
        }),
        scope: {
          schema: "schedule",
          table: "task",
          verbs: "read",
          rowFilter: [{ column: "task_id", op: "eq", value: "task-anchored" }],
          fieldMask: ["task_id", "title"],
        },
      }),
    ]);
  });

  test("derived anchor scope is enforced as one row and two fields", () => {
    const { boot, db, vault } = anchoredTaskFixture();
    const [anchor] = resolveAutomationAnchors(
      vault,
      "@[core.link_anchor/anchor-1]"
    );
    const app = ensureAppEnrolled(db, "anchored-automation");
    createGrant(db, {
      appId: app.appId,
      purposeConceptId: purposeConceptId(db, "dpv:ServiceProvision") as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes: [anchor!.scope],
    });
    const result = createGateway(db).read(
      { kind: "app", appId: app.appId, signingKey: app.signingKey },
      { entity: "schedule.task", purpose: "dpv:ServiceProvision" }
    );
    // node:sqlite hands back null-prototype rows; spreading compares the column
    // data (which is the contract) without asserting the driver's prototype.
    expect(result.rows.map((row) => ({ ...row }))).toStrictEqual([
      { task_id: "task-anchored", title: "Prepare quarterly report today" },
    ]);
  });

  test("ended or stale anchors fail closed", () => {
    const { db, vault } = anchoredTaskFixture();
    db.vault
      .prepare(
        `UPDATE core_link SET valid_to = '2026-07-25T01:00:00.000Z' WHERE link_id = 'link-1'`
      )
      .run();
    expect(() =>
      resolveAutomationAnchors(vault, "@[core.link_anchor/anchor-1]")
    ).toThrow(AutomationAnchorError);
  });

  test("moved or context-stale anchor text fails closed instead of rebinding", () => {
    const { db, vault } = anchoredTaskFixture();
    db.vault
      .prepare(
        `UPDATE schedule_task SET title = 'Later: Prepare quarterly report today' WHERE task_id = 'task-anchored'`
      )
      .run();
    expect(() =>
      resolveAutomationAnchors(vault, "@[core.link_anchor/anchor-1]")
    ).toThrow(AutomationAnchorError);
  });

  test("same-table anchors compile only when their row/field union is exact", () => {
    const { boot, db, vault } = anchoredTaskFixture();
    const [first] = resolveAutomationAnchors(
      vault,
      "@[core.link_anchor/anchor-1]"
    );
    const second = {
      ...first!,
      anchorId: "anchor-2",
      sourceId: "task-other",
      scope: {
        ...first!.scope,
        rowFilter: [
          { column: "task_id", op: "eq" as const, value: "task-other" },
        ],
      },
    };
    const combined = scopesForAutomationAnchors([first!, second]);
    expect(combined).toStrictEqual([
      {
        schema: "schedule",
        table: "task",
        verbs: "read",
        rowFilter: [
          {
            column: "task_id",
            op: "in",
            value: ["task-anchored", "task-other"],
          },
        ],
        fieldMask: ["task_id", "title"],
      },
    ]);
    const app = ensureAppEnrolled(db, "multi-anchor-automation");
    const grant = (
      scopes: Parameters<typeof createGrant>[1]["scopes"]
    ): void => {
      createGrant(db, {
        appId: app.appId,
        purposeConceptId: purposeConceptId(
          db,
          "dpv:ServiceProvision"
        ) as string,
        grantedByPartyId: boot.ownerPartyId,
        scopes,
      });
    };
    grant(combined);
    const rows = createGateway(db).read(
      { kind: "app", appId: app.appId, signingKey: app.signingKey },
      { entity: "schedule.task", purpose: "dpv:ServiceProvision" }
    ).rows;
    expect(rows).toHaveLength(2);
    expect(rows).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id: "task-anchored" }),
        expect.objectContaining({ task_id: "task-other" }),
      ])
    );
  });

  test("every anchor read is receipted through the consent gateway", () => {
    const { db, vault } = anchoredTaskFixture();
    const before = (
      db.audit.prepare("SELECT count(*) AS n FROM access_receipt").get() as {
        n: number;
      }
    ).n;
    resolveAutomationAnchors(vault, "@[core.link_anchor/anchor-1]");
    const rows = db.audit
      .prepare(
        `SELECT object_type, action, purpose_concept_id AS purpose, decision FROM access_receipt
        ORDER BY rowid DESC LIMIT ?`
      )
      .all(4) as {
      object_type: string;
      action: string;
      purpose: string;
      decision: string;
    }[];
    const after = (
      db.audit.prepare("SELECT count(*) AS n FROM access_receipt").get() as {
        n: number;
      }
    ).n;
    // These three reads ride the consent gateway; straight at `db.vault` there
    // is no credential, no purpose, and no audit trail (#541 review).
    expect(after).toBeGreaterThan(before);
    expect(rows.map((r) => r.object_type)).toStrictEqual(
      expect.arrayContaining(["core.link_anchor", "core.link", "schedule.task"])
    );
    for (const receipt of rows) {
      expect(receipt.action).toBe("read");
      expect(receipt.decision).toBe("allow");
      expect(receipt.purpose).toBe("dpv:ServiceProvision");
    }
  });

  test("an anchor source type that only names an Object member fails closed", () => {
    const { db, vault } = anchoredTaskFixture();

    // First guard, and why the row below is forged in memory: `(from_type,
    // from_id)` is a composite FK into the entity supertype (#916).
    expect(() =>
      db.vault
        .prepare(
          `UPDATE core_link SET from_type = 'constructor' WHERE link_id = 'link-1'`
        )
        .run()
    ).toThrow(/FOREIGN KEY/iu);

    // Second guard: hand the resolver such a row anyway.
    // `SEARCHABLE['constructor']` inherits an `Object` member, so a lookup
    // trusting inherited members would pass and then throw a bare TypeError.
    const forged: AnchorVaultReads = {
      credential: vault.credential,
      gateway: {
        ...vault.gateway,
        read: (credential, request) => {
          const answer = vault.gateway.read(credential, request);
          if (request.entity !== "core.link") return answer;
          return {
            ...answer,
            rows: answer.rows.map((row) => ({
              ...row,
              from_type: "constructor",
            })),
          };
        },
      } as typeof vault.gateway,
    };
    expect(() =>
      resolveAutomationAnchors(forged, "@[core.link_anchor/anchor-1]")
    ).toThrow(AutomationAnchorError);
  });

  test("non-rectangular same-table anchors fail closed instead of granting cross-pairs", () => {
    const { vault } = anchoredTaskFixture();
    const [first] = resolveAutomationAnchors(
      vault,
      "@[core.link_anchor/anchor-1]"
    );
    const second = {
      ...first!,
      anchorId: "anchor-2",
      sourceId: "task-other",
      sourceField: "description",
      scope: {
        ...first!.scope,
        rowFilter: [
          { column: "task_id", op: "eq" as const, value: "task-other" },
        ],
        fieldMask: ["task_id", "description"],
      },
    };

    expect(() => scopesForAutomationAnchors([first!, second])).toThrow(
      /without widening/u
    );
  });
});
