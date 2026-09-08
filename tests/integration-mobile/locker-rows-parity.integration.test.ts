/*
 * ONE LOCKER WINDOW, TWO SEATS (#922 E7, #928).
 *
 * `locker.item` visibility is authorised by the app grant alone — listing an
 * item is not unlocking it — so both replica seats run the app's own
 * `queries/items.ts`, `queries/search.ts` and `queries/trash.ts` against their
 * own rows instead of asking the gateway for each window. That is only safe if
 * the two seats produce the SAME rows, and this is the oracle that says so.
 *
 * Both sides run the identical modules over the identical rows
 * (`locker-vault.test-fixtures.ts`, seeded once into one replica database):
 *
 *   web    `runInlineQuery` — the shell's builder, whose `page` takes the
 *          statement, the request and the overlay as three arguments.
 *   phone  `runNativeInlineQuery` — the seat's builder, whose `page` takes one
 *          request object.
 *
 * Since #996 wave 5 both run the SAME statement against the SAME seat file, so
 * what this oracle now holds is the half that can still differ: two ctx
 * builders, two `page` shapes, one payload.
 *
 * The assertion is STRICT EQUALITY of the whole payload: a seat that agreed on
 * which titles matched while disagreeing about which of them is starred would
 * pass a title check and be wrong on screen. The lane's own tsconfig compiles
 * with `lib: DOM`, which is why this comparison lives here and not beside the
 * phone's suite.
 */
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runNativeInlineQuery } from "../../apps/mobile/src/lib/replica/inline-query-ctx.native";
import {
  LIVE_TITLES,
  seedSeatScope,
} from "../../apps/mobile/src/lib/replica/locker-vault.test-fixtures";
import {
  SeatPageFixture,
  seatOnlyReadPlane,
} from "../../apps/mobile/src/lib/replica/seat-fixture.test-fixtures";
import { tempDirSync } from "../../packages/test-kit/src/temp-dir";

interface Rows {
  items?: Array<{ title: string; favorite?: boolean; weak?: boolean }>;
  watchtower?: unknown;
  vaultDenied?: unknown;
}

/** The payload as a screen receives it — the shell attaches its pending
 *  sidecar under a symbol key, which is not data and does not cross JSON. */
function asData(value: unknown): unknown {
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
 * The modules this program cannot COMPILE, loaded the way it can RUN them.
 * The query handlers are authored against blueprints' ambient `HandlerCtx`,
 * and the shell's `inlineQueryCtx.ts` reaches `packages/client`'s browser
 * sources and their `window.CentraidApi` global. Both are resolvable at run
 * time and neither is describable inside this lane's tsconfig.
 */
async function loadUncompilable(): Promise<{
  queries: Record<string, unknown>;
  runInlineQuery: (
    module: unknown,
    options: {
      session: InlineReplicaSession;
      appId: string;
      input?: Record<string, unknown>;
    }
  ) => Promise<unknown>;
}> {
  const from = (relative: string): string =>
    new URL(relative, import.meta.url).href;
  const load = async (name: string): Promise<unknown> => {
    const module = (await import(
      /* @vite-ignore */ from(
        `../../packages/blueprints/apps/locker/queries/${name}.ts`
      )
    )) as { default: unknown };
    return module.default;
  };
  const ctx = (await import(
    /* @vite-ignore */ from(
      "../../packages/client/src/react/blueprints/inlineQueryCtx.ts"
    )
  )) as {
    runInlineQuery: (
      module: unknown,
      options: {
        session: InlineReplicaSession;
        appId: string;
        input?: Record<string, unknown>;
      }
    ) => Promise<unknown>;
  };
  return {
    queries: {
      items: await load("items"),
      search: await load("search"),
      trash: await load("trash"),
    },
    runInlineQuery: ctx.runInlineQuery,
  };
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
function locker(): string {
  const root = tempDirSync("centraid-locker-parity-");
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

describe("Locker's rows, phone against web, over the same rows", () => {
  afterEach(() => {
    for (const close of closers.splice(0)) close();
  });

  test.each([
    ["items", {}],
    ["items", { archived: true }],
    ["search", { term: "ada" }],
    ["trash", {}],
  ] as const)("the two seats answer %s identically", async (name, input) => {
    const { queries, runInlineQuery } = await loadUncompilable();
    const databaseName = locker();
    const fixture = seat(databaseName);

    const phone = (await runNativeInlineQuery(
      { default: queries[name] } as never,
      {
        session: seatOnlyReadPlane(fixture.page),
        appId: "locker",
        input,
      }
    )) as Rows;
    const web = (await runInlineQuery(
      { default: queries[name] },
      { session: webSession(fixture), appId: "locker", input }
    )) as Rows;

    // A denial or an empty answer would make the comparison vacuous.
    expect(web.vaultDenied).toBeUndefined();
    expect(web.items?.length).toBeGreaterThan(0);
    expect(asData(phone)).toStrictEqual(asData(web));
    // The mounted plane's own bookkeeping stops at the ctx, so a handler that
    // spreads a row cannot make the phone's payload a different shape.
    expect(provenanceKeys(phone)).toStrictEqual([]);
  });

  test("the window they agree on is the whole live window, decorated", async () => {
    const { queries, runInlineQuery } = await loadUncompilable();
    const databaseName = locker();
    const web = (await runInlineQuery(
      { default: queries.items },
      { session: webSession(seat(databaseName)), appId: "locker", input: {} }
    )) as Rows;

    expect(web.items?.map((row) => row.title)).toStrictEqual([...LIVE_TITLES]);
    expect(web.items?.some((row) => row.favorite === true)).toBe(true);
    // Neither seat can reach the sealed boundary, so neither claims a verdict
    // about password strength — the keys are absent on both.
    expect(web.items?.every((row) => !("weak" in row))).toBe(true);
    expect(web.watchtower).toBeUndefined();
  });
});
