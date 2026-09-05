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
 *   web    `runInlineQuery` over `ReplicaSqliteStore` — the shell's builder,
 *          the shell's read plane.
 *   phone  `runNativeInlineQuery` over `MultiVaultReplicaReader` — the seat's
 *          builder, the mounted multi-vault plane that decorates every row
 *          with `__centraid*` provenance and then strips it before the handler
 *          sees it.
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
  SHAPE_ID,
  VAULT_ID,
  seedScope,
} from "../../apps/mobile/src/lib/replica/locker-vault.test-fixtures";
import { MultiVaultReplicaReader } from "../../apps/mobile/src/lib/replica/multi-vault-reader";
import { NodeSqliteDriver } from "../../apps/mobile/src/lib/replica/node-sqlite-driver";
import { ReplicaSqliteStore } from "../../packages/client/src/replica/store-core";
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
}

const closers: Array<() => void> = [];

/** One database, seeded once; both seats open their own handle onto it. */
function locker(): string {
  const root = tempDirSync("centraid-locker-parity-");
  const databaseName = path.join(root, "personal.db");
  seedScope(databaseName);
  return databaseName;
}

/** The shell's read plane: one store, one shape, no multi-vault bookkeeping. */
function webSession(databaseName: string): InlineReplicaSession {
  const store = new ReplicaSqliteStore(
    new NodeSqliteDriver(databaseName),
    VAULT_ID
  );
  closers.push(() => store.close());
  return {
    read: (_appId, request) =>
      Promise.resolve(
        store.read({ ...(request as object), shapeId: SHAPE_ID } as never)
      ),
    search: (_appId, request) =>
      Promise.resolve(
        store.search({ ...(request as object), shapeId: SHAPE_ID } as never)
      ),
  };
}

/** The phone's read plane: the mounted reader over the same database. */
function phoneSession(databaseName: string): MultiVaultReplicaReader {
  const root = tempDirSync("centraid-locker-parity-mounted-");
  const reader = new MultiVaultReplicaReader(
    new NodeSqliteDriver(path.join(root, "mounted.db")),
    [{ vaultId: VAULT_ID, label: "Personal", canWrite: true, databaseName }]
  );
  closers.push(() => reader.close());
  return reader;
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
    const reader = phoneSession(databaseName);

    const phone = (await runNativeInlineQuery(
      { default: queries[name] } as never,
      {
        session: {
          read: reader.read.bind(reader),
          search: reader.search.bind(reader),
        },
        appId: "locker",
        input,
      }
    )) as Rows;
    const web = (await runInlineQuery(
      { default: queries[name] },
      { session: webSession(databaseName), appId: "locker", input }
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
      { session: webSession(databaseName), appId: "locker", input: {} }
    )) as Rows;

    expect(web.items?.map((row) => row.title)).toStrictEqual([...LIVE_TITLES]);
    expect(web.items?.some((row) => row.favorite === true)).toBe(true);
    // Neither seat can reach the sealed boundary, so neither claims a verdict
    // about password strength — the keys are absent on both.
    expect(web.items?.every((row) => !("weak" in row))).toBe(true);
    expect(web.watchtower).toBeUndefined();
  });
});
