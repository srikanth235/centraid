// The execution clamp (#541, re-based on the one plane by #928): a host-owned,
// per-execution attenuation of an automation's STANDING ANSWER. The answer
// decides whether the automation reaches an entity for a verb at all; the
// clamp is the only thing that narrows WHICH rows and fields, and it may only
// ever narrow — every declared restriction bites, none of them is dropped
// because another scope happened to sort first, and no clamp buys a verb the
// owner never answered for.

import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault, enrollAgent } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import type { AutomationScope } from "../grant/automation-authority.js";
import { answerScopes } from "../grant/automation-principal.test-fixtures.js";
import { evaluateAccess } from "./access.js";
import { GatewayError } from "./types.js";
import type { ExecutionScopeSpec, Identity } from "./types.js";

let db: VaultDb;
let boot: BootstrapResult;
let agent: { agentId: string; partyId: string };

describe("execution-clamp", () => {
  beforeEach(() => {
    ({ db, boot } = bootstrappedVault(
      { openVaultDb, bootstrapVault },
      { ownerName: "Priya" }
    ));
    agent = enrollAgent(db, {
      name: "digest",
      modelRef: "centraid-automation",
    });
  });

  /** The owner's standing answer — what the clamp is cut against. */
  function grant(scopes: readonly AutomationScope[]): void {
    answerScopes(db, boot, "digest", scopes);
  }

  function caller(scopeClamp?: readonly ExecutionScopeSpec[]): Identity {
    return {
      kind: "agent",
      callerId: agent.agentId,
      principalId: "digest",
      provAgentKind: "ai_agent",
      partyId: agent.partyId,
      mayAct: true,
      ...(scopeClamp ? { scopeClamp } : {}),
    };
  }

  const readTask = (identity: Identity) =>
    evaluateAccess(db.vault, identity, "core", "core_task", "read");

  test("no clamp leaves the standing answer unnarrowed", () => {
    grant([{ schema: "core", verbs: "read" }]);
    expect(readTask(caller())).toMatchObject({
      decision: "allow",
      rowFilter: [],
      fieldMask: null,
    });
  });

  test("an empty clamp fails closed — a manifest that declares nothing reads nothing", () => {
    grant([{ schema: "core", verbs: "read" }]);
    expect(readTask(caller([]))).toMatchObject({ decision: "deny" });
  });

  test("a clamp that does not cover the entity denies before any grant is consulted", () => {
    grant([{ schema: "core", verbs: "read" }]);
    const decision = readTask(
      caller([{ schema: "core", table: "core_note", verbs: "read" }])
    );
    expect(decision).toMatchObject({ decision: "deny", authorityId: null });
    assert(decision.decision === "deny");
    expect(decision.failing).toContain("execution manifest");
  });

  test("an anchored clamp attenuates a schema-wide grant to the anchored rows and fields", () => {
    grant([{ schema: "core", verbs: "read" }]);
    const decision = readTask(
      caller([
        {
          schema: "core",
          table: "core_task",
          verbs: "read",
          rowFilter: [{ column: "task_id", op: "in", value: ["t1"] }],
          fieldMask: ["task_id", "title"],
        },
      ])
    );
    expect(decision).toMatchObject({
      decision: "allow",
      rowFilter: [{ column: "task_id", op: "in", value: ["t1"] }],
      fieldMask: ["task_id", "title"],
    });
  });

  test("every clamp scope covering the entity bites — none is dropped by sort order", () => {
    grant([{ schema: "core", verbs: "read" }]);
    const schemaWide: ExecutionScopeSpec = {
      schema: "core",
      verbs: "read",
      rowFilter: [{ column: "archived_at", op: "is-null" }],
      fieldMask: ["task_id", "title", "body"],
    };
    const anchored: ExecutionScopeSpec = {
      schema: "core",
      table: "core_task",
      verbs: "read",
      rowFilter: [{ column: "task_id", op: "in", value: ["t1"] }],
      fieldMask: ["task_id", "title"],
    };
    const expected = {
      decision: "allow",
      rowFilter: [
        { column: "archived_at", op: "is-null" },
        { column: "task_id", op: "in", value: ["t1"] },
      ],
      fieldMask: ["task_id", "title"],
    };
    // The intersection is what it is regardless of which order the host listed
    // its scopes in — row filters AND, field masks intersect.
    expect(readTask(caller([schemaWide, anchored]))).toMatchObject(expected);
    expect(readTask(caller([anchored, schemaWide]))).toMatchObject({
      ...expected,
      rowFilter: [expected.rowFilter[1], expected.rowFilter[0]],
    });
  });

  test("an identical clause declared twice is ANDed once", () => {
    grant([{ schema: "core", verbs: "read" }]);
    const scope: ExecutionScopeSpec = {
      schema: "core",
      table: "core_task",
      verbs: "read",
      rowFilter: [{ column: "task_id", op: "in", value: ["t1"] }],
    };
    expect(readTask(caller([scope, structuredClone(scope)]))).toMatchObject({
      decision: "allow",
      rowFilter: [{ column: "task_id", op: "in", value: ["t1"] }],
    });
  });

  test("two clamp scopes pinning the same column differently are refused loudly", () => {
    grant([{ schema: "core", verbs: "read" }]);
    const pin = (id: string): ExecutionScopeSpec => ({
      schema: "core",
      table: "core_task",
      verbs: "read",
      rowFilter: [{ column: "task_id", op: "in", value: [id] }],
    });
    // A union ("t1 or t2") has to be ONE `in` filter — as two scopes it would
    // AND to nothing, so the clamp refuses instead of silently picking one.
    expect(() => readTask(caller([pin("t1"), pin("t2")]))).toThrow(
      GatewayError
    );
    expect(() => readTask(caller([pin("t1"), pin("t2")]))).toThrow(/task_id/u);
    // Written as the bounded union it is, it reads both rows.
    expect(
      readTask(
        caller([
          {
            schema: "core",
            table: "core_task",
            verbs: "read",
            rowFilter: [{ column: "task_id", op: "in", value: ["t1", "t2"] }],
          },
        ])
      )
    ).toMatchObject({
      rowFilter: [{ column: "task_id", op: "in", value: ["t1", "t2"] }],
    });
  });

  test("two range clauses on one column are a window, not a conflict", () => {
    grant([{ schema: "core", verbs: "read" }]);
    const decision = readTask(
      caller([
        {
          schema: "core",
          table: "core_task",
          verbs: "read",
          rowFilter: [{ column: "due_at", op: "gte", value: "2026-01-01" }],
        },
        {
          schema: "core",
          verbs: "read",
          rowFilter: [{ column: "due_at", op: "lte", value: "2026-12-31" }],
        },
      ])
    );
    expect(decision).toMatchObject({
      decision: "allow",
      rowFilter: [
        { column: "due_at", op: "gte", value: "2026-01-01" },
        { column: "due_at", op: "lte", value: "2026-12-31" },
      ],
    });
  });

  test("the clamp never widens: the standing answer stays the upper bound on VERBS", () => {
    // The owner answered for reading and nothing else. A manifest that grades
    // itself `read+act` buys no act: the clamp attenuates the answer, it never
    // stands in for one.
    grant([{ schema: "core", table: "core_task", verbs: "read" }]);
    const identity = caller([
      { schema: "core", table: "core_task", verbs: "read+act" },
    ]);
    expect(readTask(identity)).toMatchObject({ decision: "allow" });
    const act = evaluateAccess(db.vault, identity, "core", "core_task", "act");
    expect(act).toMatchObject({ decision: "deny", authorityId: null });
    assert(act.decision === "deny");
    expect(act.failing).toContain("no standing answer");
  });

  test("a clamp scope only covers the verb it grades for", () => {
    grant([{ schema: "core", verbs: "read+act" }]);
    const identity = caller([
      { schema: "core", table: "core_task", verbs: "read" },
    ]);
    expect(readTask(identity)).toMatchObject({ decision: "allow" });
    expect(
      evaluateAccess(db.vault, identity, "core", "core_task", "act")
    ).toMatchObject({
      decision: "deny",
    });
  });
});
