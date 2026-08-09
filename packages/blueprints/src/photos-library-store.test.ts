// The Photos multi-scope data layer (issue #599, apps/photos/library-store.ts).
// Two behaviours carry the whole feature and are pinned here:
//
//  * a change-feed burst tagged with ONE scope refetches THAT scope only —
//    otherwise a busy audience turns every burst into an N× read storm;
//  * "Show more" re-queries only the scopes at the merged horizon, each from
//    its own keyset cursor, and appends — otherwise paging is quadratic and
//    the settled scopes get re-read for nothing.
//
// The store takes every effect as a dependency, so the "fake" here is a
// recording reader rather than a mocked app: the assertions are about the real
// module's real calls. Loaded by file URL like the other blueprint-app fixtures.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";

interface Asset {
  asset_id: string;
  content_id: string;
  sha256?: string | null;
  taken_at?: string | null;
}
interface LibraryData {
  assets?: Asset[];
  albums?: { album_id: string }[];
  trash?: Asset[];
  tail?: string | null;
  truncated?: boolean;
  vaultDenied?: { message?: string } | null;
  error?: string;
}
type ScopeReadResult =
  | { scope: string; ok: true; data: LibraryData }
  | { scope: string; ok: false; error: { code?: string; message: string } };

interface Store {
  refreshAll: () => Promise<void>;
  refreshScope: (scopeId: string) => Promise<void>;
  showMore: () => Promise<void>;
  handleChange: (
    detail: { tables?: string[]; source?: string; scope?: string } | undefined
  ) => void;
  merged: () => {
    rows: (Asset & { scope_id: string })[];
    horizonScopeIds: string[];
  };
  scope: (scopeId: string) => {
    assets: Asset[];
    tail: string | null;
    error: string | null;
  };
  own: () => { albums: { album_id: string }[]; error: string | null };
  dispose: () => void;
}

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/photos/library-store.ts")
).href;
const { createLibraryStore } = (await import(moduleUrl)) as {
  createLibraryStore: (deps: {
    readScopes: (
      scopeIds: readonly string[],
      input: Record<string, unknown>
    ) => Promise<ScopeReadResult[]>;
    scopeIds: () => string[];
    ownScopeId: () => string;
    readTables: ReadonlySet<string>;
    schedule: (key: string, run: () => void) => void;
    onData: () => void;
    pageSize?: number;
  }) => Store;
};

const asset = (id: string, takenAt: string | null): Asset => ({
  asset_id: id,
  content_id: `c-${id}`,
  taken_at: takenAt,
});

/** One recorded fan-out: which scopes were asked, and with what input. */
interface Call {
  scopes: string[];
  input: Record<string, unknown>;
}

const SCOPES = ["own", "family", "club"];
const TABLES = new Set(["media.media_asset", "core.content_item"]);

let calls: Call[];
let answers: Map<string, LibraryData>;
let paints: number;

/** A store over three scopes whose reader answers from `answers`. */
function makeStore(overrides: { pageSize?: number } = {}): Store {
  return createLibraryStore({
    async readScopes(scopeIds, input) {
      calls.push({ scopes: [...scopeIds], input });
      return scopeIds.map((scope) => ({
        scope,
        ok: true as const,
        data: answers.get(scope) ?? {
          assets: [],
          tail: null,
          truncated: false,
        },
      }));
    },
    scopeIds: () => [...SCOPES],
    ownScopeId: () => "own",
    readTables: TABLES,
    // Immediate: the debounce is the app's, and this suite is about WHICH
    // scope gets read, not about when.
    schedule: (_key, run) => run(),
    onData: () => {
      paints += 1;
    },
    ...(overrides.pageSize == null ? {} : { pageSize: overrides.pageSize }),
  });
}
describe("photos-library-store suite", () => {
  beforeEach(() => {
    calls = [];
    paints = 0;
    answers = new Map([
      [
        "own",
        {
          assets: [asset("o1", "2026-07-10")],
          tail: "2026-07-10",
          truncated: false,
        },
      ],
      [
        "family",
        {
          assets: [asset("f1", "2026-07-09")],
          tail: "2026-07-09",
          truncated: false,
        },
      ],
      [
        "club",
        {
          assets: [asset("k1", "2026-07-08")],
          tail: "2026-07-08",
          truncated: false,
        },
      ],
    ]);
  });

  describe("Photos library store — per-scope refetch (#599)", () => {
    it("reads every mounted scope in one fan-out on a full refresh", async () => {
      const store = makeStore();
      await store.refreshAll();
      expect(calls).toStrictEqual([{ scopes: SCOPES, input: { limit: 500 } }]);
      expect(store.merged().rows.map((a) => a.asset_id)).toStrictEqual([
        "o1",
        "f1",
        "k1",
      ]);
      expect(store.merged().rows.map((a) => a.scope_id)).toStrictEqual([
        "own",
        "family",
        "club",
      ]);
    });

    it("refetches ONLY the scope a change burst is tagged with", async () => {
      const store = makeStore();
      await store.refreshAll();
      calls = [];

      store.handleChange({ tables: ["media.media_asset"], scope: "family" });
      await Promise.resolve();
      await Promise.resolve();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.scopes).toStrictEqual(["family"]);
    });

    it("falls back to every scope only when the burst names none", async () => {
      const store = makeStore();
      await store.refreshAll();
      calls = [];

      store.handleChange({ tables: ["media.media_asset"] });
      await Promise.resolve();
      await Promise.resolve();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.scopes).toStrictEqual(SCOPES);
    });

    it("ignores a burst touching none of the tables it reads", async () => {
      const store = makeStore();
      await store.refreshAll();
      calls = [];

      store.handleChange({ tables: ["core.message"], scope: "family" });
      await Promise.resolve();

      expect(calls).toStrictEqual([]);
    });

    it("fetches just the newly hydrated scope when one arrives after first paint", async () => {
      const store = makeStore();
      await store.refreshAll();
      calls = [];

      // A `scope-added` announcement carries no tables — the gate must not eat it.
      store.handleChange({ source: "scope-added", scope: "club" });
      await Promise.resolve();
      await Promise.resolve();

      expect(calls).toHaveLength(1);
      expect(calls[0]?.scopes).toStrictEqual(["club"]);
    });

    it("keeps a failing audience from blanking the scopes that answered", async () => {
      const store = createLibraryStore({
        async readScopes(scopeIds) {
          calls.push({ scopes: [...scopeIds], input: {} });
          return scopeIds.map((scope) =>
            scope === "family"
              ? { scope, ok: false as const, error: { message: "unreachable" } }
              : { scope, ok: true as const, data: answers.get(scope)! }
          );
        },
        scopeIds: () => [...SCOPES],
        ownScopeId: () => "own",
        readTables: TABLES,
        schedule: (_key, run) => run(),
        onData: () => {
          paints += 1;
        },
      });
      await store.refreshAll();
      expect(store.merged().rows.map((a) => a.asset_id)).toStrictEqual([
        "o1",
        "k1",
      ]);
      expect(store.scope("family").error).toBe("unreachable");
      expect(store.own().error).toBeNull();
    });

    it("drops an in-flight read once disposed", async () => {
      const store = makeStore();
      const pending = store.refreshAll();
      store.dispose();
      await pending;
      expect(paints).toBe(0);
    });
  });

  describe("Photos library store — show more (#599)", () => {
    beforeEach(() => {
      // Own reaches back to July 5 and is exhausted; Family stops at July 9 with
      // more behind it, so Family alone sits at the merged horizon.
      answers = new Map([
        [
          "own",
          {
            assets: [asset("o1", "2026-07-10"), asset("o2", "2026-07-05")],
            tail: "2026-07-05",
            truncated: false,
          },
        ],
        [
          "family",
          {
            assets: [asset("f1", "2026-07-09")],
            tail: "2026-07-09",
            truncated: true,
          },
        ],
        [
          "club",
          {
            assets: [asset("k1", "2026-07-08")],
            tail: "2026-07-08",
            truncated: false,
          },
        ],
      ]);
    });

    it("queries only the horizon scopes, each from its own cursor", async () => {
      const store = makeStore();
      await store.refreshAll();
      expect(store.merged().horizonScopeIds).toStrictEqual(["family"]);
      calls = [];

      answers.set("family", {
        assets: [asset("f2", "2026-07-02")],
        tail: "2026-07-02",
        truncated: false,
      });
      await store.showMore();

      expect(calls).toStrictEqual([
        { scopes: ["family"], input: { limit: 500, before: "2026-07-09" } },
      ]);
    });

    it("appends the deeper page instead of replacing what the scope held", async () => {
      const store = makeStore();
      await store.refreshAll();
      answers.set("family", {
        assets: [asset("f2", "2026-07-02")],
        tail: "2026-07-02",
        truncated: false,
      });
      await store.showMore();

      expect(store.scope("family").assets.map((a) => a.asset_id)).toStrictEqual(
        ["f1", "f2"]
      );
      expect(store.scope("family").tail).toBe("2026-07-02");
      // With nothing truncated any more, the horizon lifts and the previously
      // withheld older assets join the timeline in date order.
      expect(store.merged().rows.map((a) => a.asset_id)).toStrictEqual([
        "o1",
        "f1",
        "k1",
        "o2",
        "f2",
      ]);
    });

    it("does nothing when no scope is at a horizon", async () => {
      answers.set("family", {
        assets: [asset("f1", "2026-07-09")],
        tail: "2026-07-09",
      });
      const store = makeStore();
      await store.refreshAll();
      calls = [];
      await store.showMore();
      expect(calls).toStrictEqual([]);
    });

    it("re-reads a scope at the depth it already paged to, not back at page one", async () => {
      const store = makeStore({ pageSize: 1 });
      await store.refreshAll();
      answers.set("family", {
        assets: [asset("f2", "2026-07-02")],
        tail: "2026-07-02",
        truncated: false,
      });
      await store.showMore();
      calls = [];

      store.handleChange({ tables: ["media.media_asset"], scope: "family" });
      await Promise.resolve();
      await Promise.resolve();

      // Family holds two assets at a page size of one, so its refetch asks for
      // two — a burst must not shrink a scope back to its first page.
      expect(calls[0]).toStrictEqual({
        scopes: ["family"],
        input: { limit: 2 },
      });
    });
  });
});
