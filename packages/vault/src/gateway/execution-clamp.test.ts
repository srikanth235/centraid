// The execution clamp (issue #541): a host-owned, per-execution attenuation of
// an automation's durable grant. It may only ever NARROW what the owner
// granted — every declared restriction bites, none of them is dropped because
// another scope happened to sort first.

import { assert, beforeEach, describe, expect, test } from "vitest";

import { bootstrappedVault } from "@centraid/test-kit/vault";

import { bootstrapVault, createGrant, enrollAgent } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { evaluateConsent } from "./consent.js";
import { GatewayError } from "./types.js";
import type { ExecutionScopeSpec, Identity } from "./types.js";

const PURPOSE = "dpv:ServiceProvision";

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

  /** The owner's durable grant — the upper bound every clamp is cut against. */
  function grant(scopes: Parameters<typeof createGrant>[1]["scopes"]): void {
    createGrant(db, {
      granteePartyId: agent.partyId,
      purposeConceptId: boot.concepts[PURPOSE] as string,
      grantedByPartyId: boot.ownerPartyId,
      scopes,
    });
  }

  function caller(scopeClamp?: readonly ExecutionScopeSpec[]): Identity {
    return {
      kind: "agent",
      callerId: agent.agentId,
      provAgentKind: "ai_agent",
      partyId: agent.partyId,
      mayAct: true,
      ...(scopeClamp ? { scopeClamp } : {}),
    };
  }

  const readTask = (identity: Identity) =>
    evaluateConsent(db.vault, identity, "core", "core_task", "read", PURPOSE);

  test("no clamp leaves the durable grant exactly as the owner wrote it", () => {
    grant([{ schema: "core", verbs: "read", fieldMask: ["task_id", "title"] }]);
    expect(readTask(caller())).toMatchObject({
      decision: "allow",
      rowFilter: [],
      fieldMask: ["task_id", "title"],
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
    expect(decision).toMatchObject({ decision: "deny", grantId: null });
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

  test("the clamp never widens: the grant stays the upper bound on rows and fields", () => {
    grant([
      {
        schema: "core",
        table: "core_task",
        verbs: "read",
        rowFilter: [{ column: "archived_at", op: "is-null" }],
        fieldMask: ["task_id", "title"],
      },
    ]);
    const decision = readTask(
      caller([
        {
          schema: "core",
          verbs: "read",
          // The manifest asks for a field the owner never granted…
          fieldMask: ["task_id", "title", "body"],
        },
      ])
    );
    expect(decision).toMatchObject({
      decision: "allow",
      // …the grant's own filter survives, and the mask is the intersection.
      rowFilter: [{ column: "archived_at", op: "is-null" }],
      fieldMask: ["task_id", "title"],
    });
  });

  test("a clamp scope only covers the verb it grades for", () => {
    grant([{ schema: "core", verbs: "read+act" }]);
    const identity = caller([
      { schema: "core", table: "core_task", verbs: "read" },
    ]);
    expect(readTask(identity)).toMatchObject({ decision: "allow" });
    expect(
      evaluateConsent(db.vault, identity, "core", "core_task", "act", PURPOSE)
    ).toMatchObject({
      decision: "deny",
    });
  });
});
