import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

/**
 * SPIKE PROOF (#922 wave 1, ruling (i)): the balance-parity oracle E7 wants
 * either way.
 *
 * The claim under test is the whole loader question: Tally's
 * `queries/dashboard.ts` — the same module file the web seat imports through
 * `app-inline.tsx` — runs unmodified against the phone's mounted replica and
 * produces the same dashboard the handler contract produces over plain rows.
 *
 The reference side USED to be a row-array ctx that re-implemented the
 * declarative read grammar in JavaScript. That grammar is deleted (#996 wave
 * 5): every read on this path is now a statement, and a reference that had to
 * parse SQL to answer would be a second SQLite. So what remains is the claim
 * the spike was actually for — the same module file, unmodified, over the
 * phone's own copy of the vault — plus the provenance rule it guards.
 *
 * Comparing against the WEB BUILDER lives one program over, in
 * `tests/integration-mobile/tally-balance-parity.integration.test.ts`: that
 * builder's module reaches `packages/client`'s DOM sources, which the mobile
 * TypeScript program cannot admit, and `tests/tsconfig.json` compiles with
 * `lib: DOM` and can. The two oracles seed from one fixture
 * (`tally-ledger.test-fixtures.ts`), so they are answering about the same
 * rows.
 */
import type { Money, Valuation } from "@centraid/core/money";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

// The one module under test, imported exactly as the web seat imports it.
import dashboardQuery from "../../../../../packages/blueprints/apps/tally/queries/dashboard.ts";
import { runNativeInlineQuery } from "./inline-query-ctx.native";
import {
  SeatPageFixture,
  seatOnlyReadPlane,
} from "./seat-fixture.test-fixtures";
import { OWNER, seedSeatScope } from "./tally-ledger.test-fixtures";

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

let open: SeatPageFixture | undefined;

/** The phone's seat, over one seeded file. */
function seatSession(): ReturnType<typeof seatOnlyReadPlane> {
  const root = tempDirSync("centraid-inline-query-spike-");
  const databaseName = path.join(root, "personal.db");
  seedSeatScope(databaseName);
  open = new SeatPageFixture(databaseName);
  return seatOnlyReadPlane(open.page);
}

interface DashboardOutput {
  me: string | null;
  currency: string;
  friends: Array<{ party_id: string; balances: Money[] }>;
  groups: unknown[];
  archived_groups: unknown[];
  trash: unknown[];
  recurring: unknown[];
  owe: Valuation;
  owed: Valuation;
  expense_count: number;
  settlement_count: number;
  vaultDenied?: unknown;
}

describe("Metro-loadable queries/*.ts spike (#922 wave 1 ruling (i))", () => {
  afterEach(() => {
    open?.close();
    open = undefined;
  });

  test("Tally's dashboard handler runs on the phone's own seat", async () => {
    const session = seatSession();
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
    // The two positions carry amounts; neither is summed into the other
    // (#996, ruling R22).
    expect(
      output.owe.components.length + output.owed.components.length
    ).toBeGreaterThan(0);
    // The trashed expense is out of the balances and in the trash list.
    expect(output.trash).toHaveLength(1);
    expect(output.groups).toHaveLength(1);
    expect(output.archived_groups).toHaveLength(1);
    expect(output.recurring).toHaveLength(1);
  });

  test("the payload carries none of this seat's own bookkeeping", async () => {
    const session = seatSession();
    const native = (await runNativeInlineQuery(
      { default: dashboardQuery } as never,
      { session, appId: "tally" }
    )) as DashboardOutput;

    // A handler that SPREADS a row — `recurring` does — must not emit the
    // seat's provenance into a payload the web seat's version of the same
    // payload does not carry (#922 E7, precondition (b)). On the seat the row
    // IS the table's columns, so the rule is now a property of the read
    // rather than of a strip, and this is what proves it stayed true.
    expect(native.vaultDenied).toBeUndefined();
    expect(provenanceKeys(native)).toStrictEqual([]);
  });
});
