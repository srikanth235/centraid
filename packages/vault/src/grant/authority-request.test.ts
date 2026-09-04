// A PARKED ASK IS NOT AN ANSWER (#308 A4, re-homed by #928). Two facts share
// this suite because they are the two halves of one question the owner has
// been shown: `share_authority_request` holds what has been ASKED and not yet
// decided, and `share_authority` holds what was SAID. The invariant #541
// protected — a narrow "yes" never erases a broader "no" — survives the move,
// because an answer is keyed by the exact (subject, verb) triple it answers.

import { beforeEach, describe, expect, test } from "vitest";

import { bootstrapVault, enrollAgent } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  closeObsoleteScopeRequest,
  getOpenScopeRequest,
  listOpenScopeRequests,
  markScopeRequestDecided,
  openScopeRequest,
} from "./authority-request.js";
import { automationAnswers } from "./automation-authority.js";
import { answerScopes } from "./automation-principal.test-fixtures.js";

const PRINCIPAL = "planner";

let db: VaultDb;
let boot: BootstrapResult;

describe("authority-request", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    enrollAgent(db, { name: PRINCIPAL, modelRef: "test-automation" });
  });

  test("a widened manifest parks as ONE open ask per automation", () => {
    const first = openScopeRequest(db, {
      principalId: PRINCIPAL,
      scopes: [{ schema: "core", verbs: "read" }],
    });
    // A re-publish replaces the open ask rather than queueing a second one.
    const second = openScopeRequest(db, {
      principalId: PRINCIPAL,
      scopes: [{ schema: "core", verbs: "read+act" }],
    });
    expect(second).toBe(first);
    const open = listOpenScopeRequests(db);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      requestId: first,
      principalId: PRINCIPAL,
      scopes: [{ schema: "core", verbs: "read+act" }],
    });
  });

  test("parking answers nothing: the plane still holds no standing answer", () => {
    openScopeRequest(db, {
      principalId: PRINCIPAL,
      scopes: [{ schema: "core", verbs: "read" }],
    });
    expect(automationAnswers(db.vault, PRINCIPAL)).toStrictEqual([]);
  });

  test("deciding closes the ask, and a manifest that stops widening drops it", () => {
    const requestId = openScopeRequest(db, {
      principalId: PRINCIPAL,
      scopes: [{ schema: "core", verbs: "read" }],
    });
    expect(getOpenScopeRequest(db, requestId)).toBeDefined();
    markScopeRequestDecided(db, requestId, "denied");
    expect(getOpenScopeRequest(db, requestId)).toBeUndefined();
    expect(listOpenScopeRequests(db)).toStrictEqual([]);

    openScopeRequest(db, {
      principalId: PRINCIPAL,
      scopes: [{ schema: "knowledge", verbs: "read" }],
    });
    closeObsoleteScopeRequest(db, PRINCIPAL);
    expect(listOpenScopeRequests(db)).toStrictEqual([]);
  });

  test("open asks are per automation: deciding one leaves the other parked", () => {
    enrollAgent(db, { name: "notes", modelRef: "test-automation" });
    const mine = openScopeRequest(db, {
      principalId: PRINCIPAL,
      scopes: [{ schema: "core", verbs: "read" }],
    });
    openScopeRequest(db, {
      principalId: "notes",
      scopes: [{ schema: "core", verbs: "read" }],
    });
    markScopeRequestDecided(db, mine, "approved");
    expect(listOpenScopeRequests(db).map((r) => r.principalId)).toStrictEqual([
      "notes",
    ]);
  });

  test("a narrow YES leaves the broader NO standing (issue #541, in the one plane)", () => {
    // The owner refuses the whole `core` pack for reads…
    answerScopes(
      db,
      boot,
      PRINCIPAL,
      [{ schema: "core", verbs: "read" }],
      "declined"
    );
    // …then later says yes to ONE entity. That is a yes about `core.task`, not
    // a retraction of the pack-wide no: answers are keyed by their exact
    // subject, so the two rows coexist and the broad refusal still reads as
    // "asked and told no".
    answerScopes(db, boot, PRINCIPAL, [
      { schema: "core", table: "task", verbs: "read" },
    ]);
    expect(
      automationAnswers(db.vault, PRINCIPAL).map((answer) => ({
        subjectType: answer.subjectType,
        subjectId: answer.subjectId,
        verb: answer.verb,
        decision: answer.decision,
      }))
    ).toStrictEqual([
      {
        subjectType: "agent.pack",
        subjectId: "core",
        verb: "read",
        decision: "declined",
      },
      {
        subjectType: "core.entity",
        subjectId: "core.task",
        verb: "read",
        decision: "granted",
      },
    ]);
  });

  test("re-answering the exact subject the other way revokes the standing row", () => {
    answerScopes(
      db,
      boot,
      PRINCIPAL,
      [{ schema: "core", verbs: "read" }],
      "declined"
    );
    answerScopes(db, boot, PRINCIPAL, [{ schema: "core", verbs: "read" }]);
    const live = automationAnswers(db.vault, PRINCIPAL);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ decision: "granted" });
    // The refusal is not forgotten — it is history, with an end date.
    const all = db.vault
      .prepare(
        `SELECT decision, revoked_at FROM share_authority
          WHERE principal_kind = 'automation' AND principal_id = ?
          ORDER BY granted_at, rowid`
      )
      .all(PRINCIPAL) as { decision: string; revoked_at: string | null }[];
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ decision: "declined" });
    expect(all[0]?.revoked_at).not.toBeNull();
  });

  test("an answer already standing is not written twice", () => {
    answerScopes(db, boot, PRINCIPAL, [{ schema: "core", verbs: "read" }]);
    answerScopes(db, boot, PRINCIPAL, [{ schema: "core", verbs: "read" }]);
    expect(automationAnswers(db.vault, PRINCIPAL)).toHaveLength(1);
  });
});
