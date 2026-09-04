/**
 * SPIKE PROOF (#922 wave 1, ruling (i)): the balance-parity oracle E7 wants
 * either way.
 *
 * The claim under test is the whole loader question: Tally's
 * `queries/dashboard.ts` — the same module file the web seat imports through
 * `app-inline.tsx` — runs unmodified against the phone's mounted replica and
 * produces the same dashboard the handler contract produces over plain rows.
 *
 * The reference side is a row-array ctx presenting exactly the surface both
 * `ctx` builders present (`{ rows, receiptId }` plus the shared `ctx.time`
 * engine), fed the identical fixture — the mounted read PLANE is what this
 * file varies, so the reference is the same handler over plain arrays.
 *
 * Comparing against the WEB BUILDER lives one program over, in
 * `tests/integration-mobile/tally-balance-parity.integration.test.ts`: that
 * builder's module reaches `packages/client`'s DOM sources, which the mobile
 * TypeScript program cannot admit, and `tests/tsconfig.json` compiles with
 * `lib: DOM` and can. The two oracles seed from one fixture
 * (`tally-ledger.test-fixtures.ts`), so they are answering about the same
 * rows.
 */
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { ReplicaRow } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

// The one module under test, imported exactly as the web seat imports it.
import dashboardQuery from "../../../../../packages/blueprints/apps/tally/queries/dashboard.ts";
import type { NativeInlineQuerySession } from "./inline-query-ctx.native";
import { runNativeInlineQuery } from "./inline-query-ctx.native";
import { MultiVaultReplicaReader } from "./multi-vault-reader";
import { NodeSqliteDriver } from "./node-sqlite-driver";
import {
  OWNER,
  SHAPE_ID,
  VAULT_ID,
  seedEntities,
  seedScope,
} from "./tally-ledger.test-fixtures";

/**
 * The reference read plane: the SAME fixture rows, filtered in JavaScript
 * rather than by the replica's compiled plan. It answers the `where`/`orderBy`/
 * `limit` grammar Tally's dashboard actually uses, and nothing else — an
 * unhandled operator throws rather than silently returning the wrong page.
 */
function rowArraySession(): NativeInlineQuerySession {
  const byEntity = new Map(
    seedEntities().map((entity) => [entity.entity, entity])
  );
  return {
    read: (_appId, request) => {
      const entity = byEntity.get(request.entity);
      let rows = [...(entity?.rows ?? [])];
      for (const clause of request.where ?? []) {
        const value = clause.value;
        rows = rows.filter((row) => {
          const held = row[clause.column] ?? null;
          if (clause.op === "is-null") return held === null;
          if (clause.op === "not-null") return held !== null;
          if (clause.op === "eq") return held === value;
          if (clause.op === "in") return (value as unknown[]).includes(held);
          throw new Error(`unsupported operator ${clause.op}`);
        });
      }
      const order = request.orderBy;
      if (order?.dir)
        rows.sort((left, right) => {
          const a = String(left[order.column] ?? "");
          const b = String(right[order.column] ?? "");
          return order.dir === "desc" ? b.localeCompare(a) : a.localeCompare(b);
        });
      if (request.limit !== undefined) rows = rows.slice(0, request.limit);
      return Promise.resolve({
        rows: rows.map((values) => ({
          rowId: String(values[entity!.primaryKey]),
          values: values as ReplicaRow,
          oversizedFields: [],
          hasUnavailableFields: false,
        })),
        cursor: { epoch: "epoch-1", seq: 1 },
        dependency: { shapeId: SHAPE_ID, entity: request.entity },
      });
    },
    search: () => Promise.reject(new Error("the dashboard does not search")),
  };
}

/** Every `__centraid*` key anywhere in a payload — expected to be none. */
function provenanceKeys(value: unknown): string[] {
  if (Array.isArray(value))
    return value.flatMap((item) => provenanceKeys(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) =>
      key.startsWith("__centraid") ? [key] : provenanceKeys(item)
  );
}

let open: MultiVaultReplicaReader | undefined;

function mountedReader(): MultiVaultReplicaReader {
  const root = tempDirSync("centraid-inline-query-spike-");
  const databaseName = path.join(root, "personal.db");
  seedScope(databaseName);
  open = new MultiVaultReplicaReader(
    new NodeSqliteDriver(path.join(root, "mounted.db")),
    [{ vaultId: VAULT_ID, label: "Personal", canWrite: true, databaseName }]
  );
  return open;
}

interface DashboardOutput {
  me: string | null;
  currency: string;
  friends: Array<{ party_id: string; net_minor: number }>;
  groups: unknown[];
  archived_groups: unknown[];
  trash: unknown[];
  recurring: unknown[];
  owe_total_minor: number;
  owed_total_minor: number;
  expense_count: number;
  settlement_count: number;
  vaultDenied?: unknown;
}

describe("Metro-loadable queries/*.ts spike (#922 wave 1 ruling (i))", () => {
  afterEach(() => {
    open?.close();
    open = undefined;
  });

  test("Tally's dashboard handler runs on the native replica session", async () => {
    const reader = mountedReader();
    const session = {
      read: reader.read.bind(reader),
      search: reader.search.bind(reader),
    };
    const output = (await runNativeInlineQuery(
      { default: dashboardQuery } as never,
      { session, appId: "tally" }
    )) as DashboardOutput;

    // A denial or an empty ledger would make the parity assertion vacuous.
    expect(output.vaultDenied).toBeUndefined();
    expect(output.me).toBe(OWNER);
    expect(output.currency).toBe("GBP");
    expect(output.expense_count).toBe(40);
    expect(output.settlement_count).toBe(1);
    expect(output.friends).toHaveLength(3);
    expect(output.owe_total_minor + output.owed_total_minor).toBeGreaterThan(0);
    // The trashed expense is out of the balances and in the trash list.
    expect(output.trash).toHaveLength(1);
    expect(output.groups).toHaveLength(1);
    expect(output.archived_groups).toHaveLength(1);
    expect(output.recurring).toHaveLength(1);
  });

  test("replica-backed and row-array ctx produce identical output", async () => {
    const reader = mountedReader();
    const session = {
      read: reader.read.bind(reader),
      search: reader.search.bind(reader),
    };
    const native = (await runNativeInlineQuery(
      { default: dashboardQuery } as never,
      { session, appId: "tally" }
    )) as DashboardOutput;
    const reference = (await runNativeInlineQuery(
      { default: dashboardQuery } as never,
      { session: rowArraySession(), appId: "tally" }
    )) as DashboardOutput;

    expect(reference.vaultDenied).toBeUndefined();
    // BYTE FOR BYTE, not "the same once provenance is filtered out" (#922 E7,
    // precondition (b)). The mounted plane still decorates every row with
    // `__centraidScopeId` and its siblings — that is how a household's rows
    // know which vault they came from — but `withoutScopeProvenance` strips
    // them before a handler sees the row, so a handler that SPREADS a row
    // (`recurring` does) cannot leak this seat's own bookkeeping into a
    // payload the web seat's version of the same payload does not carry.
    expect(native).toStrictEqual(reference);
    expect(provenanceKeys(native)).toStrictEqual([]);
    expect(native.owed_total_minor).toBe(reference.owed_total_minor);
    expect(native.owe_total_minor).toBe(reference.owe_total_minor);
  });
});
