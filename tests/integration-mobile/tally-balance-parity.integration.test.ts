/*
 * ONE BALANCE ENGINE, TWO SEATS (#922 E7).
 *
 * Tally's `queries/dashboard.ts` derives every net, share and total at read
 * time. Until this lane the phone could not run it: it asked the gateway for
 * the answer over seven RPCs. It runs it now, on its own mounted replica —
 * which is only safe if the answer is the SAME answer, and this is the oracle
 * that says so.
 *
 * Both sides run the identical module over the identical rows
 * (`tally-ledger.test-fixtures.ts`, seeded once into one replica database):
 *
 *   web    `runInlineQuery` — the shell's builder, whose `page` takes the
 *          statement, the request and the overlay as three arguments.
 *   phone  `runNativeInlineQuery` — the seat's builder, whose `page` takes one
 *          request object (precondition (b)).
 *
 * Since #996 wave 5 both run the SAME statement against the SAME seat file, so
 * what this oracle now holds is the half that can still differ: two ctx
 * builders, two `page` shapes, one payload.
 *
 * The assertion is STRICT EQUALITY of the whole payload, not of the totals: a
 * seat that agreed on `owed_total_minor` while disagreeing about which friend
 * owes it would pass a totals check and be wrong on screen. The lane's own
 * tsconfig compiles with `lib: DOM`, which is why this comparison lives here
 * and not beside the phone's suite.
 */
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runNativeInlineQuery } from "../../apps/mobile/src/lib/replica/inline-query-ctx.native";
import {
  SeatPageFixture,
  seatOnlyReadPlane,
} from "../../apps/mobile/src/lib/replica/seat-fixture.test-fixtures";
import { seedSeatScope } from "../../apps/mobile/src/lib/replica/tally-ledger.test-fixtures";
import type { Money, Valuation } from "../../packages/core/src/money";
import { tempDirSync } from "../../packages/test-kit/src/temp-dir";

/**
 * The dashboard as the query actually returns it (#996 R22).
 *
 * IT USED TO SAY `owe_total_minor` / `owed_total_minor` AND `net_minor`, and
 * that shape is gone: a bare minor-unit integer cannot be rendered as a
 * balance, because a bag of USD 100 and EUR 100 has no single number. The
 * handler returns `Valuation`s and per-currency `Money` bags instead. This
 * interface said otherwise, so the non-vacuity guard below was reading
 * `undefined + undefined` and asserting `NaN > 0` — which failed loudly, but
 * only because NaN fails every comparison. Had the guard been `>= 0` it would
 * have passed over an empty payload for as long as anyone cared to look.
 */
interface Dashboard {
  me: string | null;
  currency: string;
  friends: Array<{ party_id: string; balances: Money[] }>;
  owe: Valuation;
  owed: Valuation;
  expense_count: number;
  recurring: unknown[];
  vaultDenied?: unknown;
}

/**
 * The absolute size of a valuation — "is there anything here", never a figure
 * a surface would render (#996, R22). Spelled the same way
 * `apps/mobile/src/apps/tally/tally-airplane.test.ts` spells it, so the two
 * lanes cannot drift into two readings of one type.
 */
function valuationTotalMinor(valuation: Valuation): number {
  return valuation.state === "valued"
    ? Math.abs(valuation.total.amount_minor)
    : valuation.components.reduce(
        (total, amount) => total + Math.abs(amount.amount_minor),
        0
      );
}

/**
 * The payload as a screen receives it.
 *
 * The two builders differ in ONE thing and it is deliberate: the shell's
 * `runInlineQuery` attaches the read's pending sidecar to the WHOLE payload as
 * a symbol key, because the web seat carries pending-row identity across a
 * projection; the phone attaches it to each row, which is where its screens
 * read it. A symbol is not data — it does not cross JSON, a view model, or a
 * wire — so the comparison is over what actually reaches a surface.
 */
function asData(value: unknown): unknown {
  // Not `structuredClone`: a structured clone COPIES symbol-keyed properties,
  // and the shell's payload-level sidecar is exactly the symbol this must drop.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- (#922) the JSON round trip is the point: it is what a surface receives
  return JSON.parse(JSON.stringify(value)) as unknown;
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

/**
 * The two modules this program cannot COMPILE, loaded the way it can RUN them.
 *
 * `queries/dashboard.ts` is authored against blueprints' ambient `HandlerCtx`,
 * and the shell's `inlineQueryCtx.ts` reaches `packages/client`'s browser
 * sources and their `window.CentraidApi` global. Both are resolvable at run
 * time and neither is describable inside this lane's tsconfig, so they arrive
 * through a specifier tsc cannot follow — the alternative was widening a
 * type-checker config for one test.
 */
async function loadUncompilable(): Promise<{
  dashboardQuery: unknown;
  runInlineQuery: (
    module: unknown,
    options: { session: InlineReplicaSession; appId: string }
  ) => Promise<unknown>;
}> {
  const from = (relative: string): string =>
    new URL(relative, import.meta.url).href;
  const queryPath = from(
    "../../packages/blueprints/apps/tally/queries/dashboard.ts"
  );
  const ctxPath = from(
    "../../packages/client/src/react/blueprints/inlineQueryCtx.ts"
  );
  const query = (await import(/* @vite-ignore */ queryPath)) as {
    default: unknown;
  };
  const ctx = (await import(/* @vite-ignore */ ctxPath)) as {
    runInlineQuery: (
      module: unknown,
      options: { session: InlineReplicaSession; appId: string }
    ) => Promise<unknown>;
  };
  return { dashboardQuery: query.default, runInlineQuery: ctx.runInlineQuery };
}

/** The shell's read surface, restated: the module it comes from is loaded at
 *  run time, so the type this lane compiles against is written here. */
interface InlineReplicaSession {
  read: (appId: string, request: never) => Promise<unknown>;
  search: (appId: string, request: never) => Promise<unknown>;
  page?: (query: never, request: never, overlay?: never) => Promise<unknown>;
}

const closers: Array<() => void> = [];

/** One database, seeded once; both seats open their own handle onto it. */
function ledger(): string {
  const root = tempDirSync("centraid-tally-parity-");
  const databaseName = path.join(root, "personal.db");
  seedSeatScope(databaseName);
  return databaseName;
}

/** One seat file, one handle, closed with the test. */
function seat(databaseName: string): SeatPageFixture {
  const fixture = new SeatPageFixture(databaseName);
  closers.push(() => fixture.close());
  return fixture;
}

/**
 * The shell's read plane. Its `page` is POSITIONAL — statement, request,
 * overlay — where the phone's is one object, and that difference is the whole
 * of what this oracle still varies.
 */
function webSession(fixture: SeatPageFixture): InlineReplicaSession {
  const refuse = (): never => {
    throw new Error(
      "this seat answers pages only: the declarative read is not part of it"
    );
  };
  return {
    read: refuse,
    search: refuse,
    page: ((query: never, request: { limit: number; after?: never }) =>
      fixture.page({
        query,
        limit: request.limit,
        ...(request.after ? { after: request.after } : {}),
      })) as InlineReplicaSession["page"],
  };
}

describe("Tally's balances, phone against web, over the same rows", () => {
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  test("the two seats derive the identical dashboard", async () => {
    const { dashboardQuery, runInlineQuery } = await loadUncompilable();
    const databaseName = ledger();
    const fixture = seat(databaseName);

    const phone = (await runNativeInlineQuery(
      { default: dashboardQuery } as never,
      { session: seatOnlyReadPlane(fixture.page), appId: "tally" }
    )) as Dashboard;
    const web = (await runInlineQuery(
      { default: dashboardQuery },
      { session: webSession(fixture), appId: "tally" }
    )) as Dashboard;

    // A denial or an empty ledger would make the comparison vacuous.
    expect(web.vaultDenied).toBeUndefined();
    expect(web.expense_count).toBe(40);
    expect(web.friends).toHaveLength(3);
    expect(
      valuationTotalMinor(web.owe) + valuationTotalMinor(web.owed)
    ).toBeGreaterThan(0);

    // THE TWO FIELDS, ROW SHAPE AND ALL, not just their sum and not only
    // through the whole-payload compare below. A driver that handed one seat a
    // bigint where the other got a number, or dropped a component of a
    // multi-currency bag, would survive a total and die here.
    expect(phone.owe).toStrictEqual(web.owe);
    expect(phone.owed).toStrictEqual(web.owed);
    expect(phone.owe.state).toBe(web.owe.state);
    expect(phone.friends.map((friend) => friend.balances)).toStrictEqual(
      web.friends.map((friend) => friend.balances)
    );

    expect(asData(phone)).toStrictEqual(asData(web));
    // The mounted plane's own bookkeeping stops at the ctx, so a handler that
    // spreads a row cannot make the phone's payload a different shape.
    expect(provenanceKeys(phone)).toStrictEqual([]);
  });

  test("every friend's net agrees, not just the totals", async () => {
    const { dashboardQuery, runInlineQuery } = await loadUncompilable();
    const databaseName = ledger();
    const fixture = seat(databaseName);

    const phone = (await runNativeInlineQuery(
      { default: dashboardQuery } as never,
      { session: seatOnlyReadPlane(fixture.page), appId: "tally" }
    )) as Dashboard;
    const web = (await runInlineQuery(
      { default: dashboardQuery },
      { session: webSession(fixture), appId: "tally" }
    )) as Dashboard;

    // PER-CURRENCY BAGS, not a net integer (#996 R22). This read
    // `friend.net_minor` — a field the same ruling removed — so both seats
    // returned `undefined`, `toStrictEqual` agreed about it, and the
    // non-vacuity guard passed on `undefined !== 0`. It was agreement about
    // nothing, in the test whose whole job is to prove the two seats agree
    // about something.
    const bags = (data: Dashboard): Array<[string, Money[]]> =>
      data.friends
        .map((friend): [string, Money[]] => [friend.party_id, friend.balances])
        .sort(([left], [right]) => left.localeCompare(right));

    expect(bags(phone)).toStrictEqual(bags(web));
    // Non-zero, so agreement is agreement about arithmetic rather than zeroes.
    expect(
      bags(phone).some(([, balances]) =>
        balances.some((amount) => amount.amount_minor !== 0)
      )
    ).toBe(true);
  });
});
