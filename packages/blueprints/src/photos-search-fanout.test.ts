// @vitest-environment jsdom
// Photos' cross-scope search fan-out (#726 D10/D11 finding 3): the EXIT
// EVIDENCE that a scope which failed to answer no longer blanks a scope that
// DID — the exact bug the audit named ("one friend's sleeping machine blanks
// the owner's own library"). `search-scaffold.test.ts` already proves
// `perScopeReach`/`scopeReachFacts` correct in isolation; what matters here is
// that `createSearch` (apps/photos/search.ts) actually consumes them rather
// than collapsing reach into one boolean. Loaded by file URL, since
// `search.ts` reads `window.centraid` live; its `@centraid/design/elements`
// import resolves to that package's source through this package's own
// `vitest.config.ts` alias.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

interface Asset {
  asset_id: string;
  content_id: string;
  sha256?: string | null;
  taken_at?: string | null;
  scope_id?: string;
}
interface ReachFact {
  label: string;
  value: string;
}
type ScopeRead =
  | { scope: string; ok: true; data: { assets?: Asset[] } }
  | { scope: string; ok: false; error: { message: string } };

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/photos/search.ts")
).href;
const { createSearch } = (await import(moduleUrl)) as {
  createSearch: (opts: {
    getQuery: () => string;
    setResults: (r: Asset[] | null) => void;
    setStatus: (status: string) => void;
    renderGrid: () => void;
    setReachFacts?: (facts: readonly ReachFact[]) => void;
  }) => { run: () => void; invalidate: () => void };
};

const asset = (id: string, takenAt: string): Asset => ({
  asset_id: id,
  content_id: id,
  taken_at: takenAt,
});

function mount(
  scopes: { id: string; label: string; canWrite: boolean }[],
  readAll: (opts: { scopes?: readonly string[] }) => Promise<ScopeRead[]>
): void {
  (globalThis as { window?: unknown }).window = {
    centraid: {
      scopes,
      read: () => Promise.reject(new Error("no read")),
      readAll,
    },
  };
}

/** Drives one debounced `run()` to completion under fake timers and captures
 *  what it reported. */
async function search(
  query: string
): Promise<{ results: Asset[] | null; status: string; facts: ReachFact[] }> {
  let results: Asset[] | null = null;
  let status = "";
  let facts: ReachFact[] = [];
  const { run } = createSearch({
    getQuery: () => query,
    setResults: (r) => {
      results = r;
    },
    setStatus: (s) => {
      status = s;
    },
    renderGrid: () => undefined,
    setReachFacts: (f) => {
      facts = [...f];
    },
  });
  run();
  await vi.advanceTimersByTimeAsync(150);
  return { results, status, facts };
}

describe("Photos search fan-out — per-scope reach (#726 D10/D11)", () => {
  beforeEach(() => {
    useFakeClock();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("keeps the OWN scope's results and stays `ready` when a shared scope is unreachable — names it in reachFacts instead of blanking the answer", async () => {
    mount(
      [
        { id: "own", label: "Library", canWrite: true },
        { id: "commons", label: "Priya", canWrite: false },
      ],
      () =>
        Promise.resolve([
          {
            scope: "own",
            ok: true,
            data: { assets: [asset("a1", "2020-01-01")] },
          },
          { scope: "commons", ok: false, error: { message: "peer offline" } },
        ])
    );
    const { results, status, facts } = await search("beach");
    expect(status).toBe("ready");
    expect(results?.map((a) => a.asset_id)).toStrictEqual(["a1"]);
    expect(facts).toStrictEqual([{ label: "commons", value: "peer offline" }]);
  });

  it("collapses to `unreachable` only when NOTHING reached — the one case with nothing genuine to show", async () => {
    mount(
      [
        { id: "own", label: "Library", canWrite: true },
        { id: "commons", label: "Priya", canWrite: false },
      ],
      () =>
        Promise.resolve([
          { scope: "own", ok: false, error: { message: "vault offline" } },
          { scope: "commons", ok: false, error: { message: "peer offline" } },
        ])
    );
    const { results, status, facts } = await search("beach");
    expect(status).toBe("unreachable");
    expect(results).toBeNull();
    // No results ⇒ nothing to name a fact beside; the shelf's own unreachable
    // panel already speaks for the whole search.
    expect(facts).toStrictEqual([]);
  });

  it("has empty reachFacts once every mounted scope answers — no stale short-scope note left over", async () => {
    mount(
      [
        { id: "own", label: "Library", canWrite: true },
        { id: "commons", label: "Priya", canWrite: false },
      ],
      () =>
        Promise.resolve([
          {
            scope: "own",
            ok: true,
            data: { assets: [asset("a1", "2020-01-01")] },
          },
          {
            scope: "commons",
            ok: true,
            data: { assets: [asset("a2", "2020-02-02")] },
          },
        ])
    );
    const { status, facts } = await search("beach");
    expect(status).toBe("ready");
    expect(facts).toStrictEqual([]);
  });

  it("clears reachFacts on a resting (empty-query) call — a cleared search box carries no stale reach note", async () => {
    mount([{ id: "own", label: "Library", canWrite: true }], () =>
      Promise.resolve([{ scope: "own", ok: true, data: { assets: [] } }])
    );
    const { status, facts, results } = await search("");
    expect(status).toBe("resting");
    expect(facts).toStrictEqual([]);
    expect(results).toBeNull();
  });
});
