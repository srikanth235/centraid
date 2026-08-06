// @vitest-environment jsdom
// THE DUPLICATE REVIEW's real decision logic (v4 handoff proto :4291-:4303).
//
// Two things here are load-bearing and neither is cosmetic:
//
//   1. WHICH COPY IS KEPT. A `Trash` press destroys every copy this module did
//      not choose, so the choice has to be deterministic (the same cluster
//      proposes the same keeper every time, in any row order) and it may only
//      claim `largest` when the rows actually support that word.
//   2. WHAT THE COUNTS ARE. "2 copies to trash" and "The other 2 go to trash"
//      are promises about how many photographs a press removes; they are
//      derived from the same decision the press acts on, never counted twice.
//
// The view is rendered to static markup, like every other pure-view fixture in
// this package (photos-picker.test.ts): `DuplicateReviewView` is a pure view
// over its props, so the markup IS the behaviour.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface Copy {
  asset_id: string;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  byte_size?: number | null;
  taken_at?: string | null;
  content_uri?: string | null;
}
interface Cluster {
  key: string;
  assets: Copy[];
}

const { decideCluster } = (await import(app("duplicate-decision.ts"))) as {
  decideCluster: (
    assets: readonly Copy[],
    override?: string | null
  ) => { keptId: string; reason: string | null; trashIds: string[] } | null;
};
const { DuplicateReviewView } = (await import(
  app("components/DuplicateReview.tsx")
)) as {
  DuplicateReviewView: ComponentType<{
    cluster: Cluster;
    index: number;
    total: number;
    rung: number;
    keptId: string | null;
    busy?: boolean;
    onKeep: (assetId: string) => void;
    onTrashRest: (assetIds: string[]) => void;
    onKeepAll: () => void;
  }>;
};

const copy = (id: string, over: Partial<Copy> = {}): Copy => ({
  asset_id: id,
  title: `${id}.HEIC`,
  width: 4032,
  height: 3024,
  taken_at: "2026-03-11T09:00:00.000Z",
  content_uri: "data:image/jpeg;base64,AAAA",
  ...over,
});

const review = (
  cluster: Cluster,
  over: { index?: number; total?: number; keptId?: string | null } = {}
): string =>
  renderToStaticMarkup(
    createElement(DuplicateReviewView, {
      cluster,
      index: over.index ?? 1,
      total: over.total ?? 6,
      rung: 1,
      keptId: over.keptId ?? null,
      onKeep: () => {},
      onTrashRest: () => {},
      onKeepAll: () => {},
    })
  );

describe("which copy the review proposes to keep", () => {
  it("keeps the biggest recorded copy and says why", () => {
    const decision = decideCluster([
      copy("small", { byte_size: 820_000, width: 1600, height: 1200 }),
      copy("big", { byte_size: 4_100_000 }),
      copy("mid", { byte_size: 4_000_000 }),
    ]);
    expect(decision).not.toBeNull();
    expect(decision!.keptId).toBe("big");
    expect(decision!.reason).toBe("largest");
    expect(decision!.trashIds).toStrictEqual(["small", "mid"]);
  });

  it("does not say `largest` when the biggest size is a tie", () => {
    // The prototype's own cluster: two copies at 4.1 MB and one at 820 KB.
    // Something still has to be kept, but nothing measured makes one of the
    // two tied copies the larger, so the word is withheld rather than guessed.
    const decision = decideCluster([
      copy("a", { byte_size: 4_100_000 }),
      copy("b", { byte_size: 4_100_000 }),
      copy("c", { byte_size: 820_000, width: 1600, height: 1200 }),
    ]);
    expect(decision!.reason).toBeNull();
    expect(decision!.trashIds).toHaveLength(2);
  });

  it("does not say `largest` when a copy recorded no size at all", () => {
    const decision = decideCluster([
      copy("sized", { byte_size: 4_100_000 }),
      copy("unsized", { byte_size: null, content_uri: null }),
    ]);
    expect(decision!.reason).toBeNull();
  });

  it("is deterministic: row order never changes the answer", () => {
    const rows = [
      copy("a", { byte_size: 1_000, taken_at: "2026-03-11T09:00:02.000Z" }),
      copy("b", { byte_size: 1_000, taken_at: "2026-03-11T09:00:00.000Z" }),
      copy("c", { byte_size: 1_000, taken_at: "2026-03-11T09:00:01.000Z" }),
    ];
    const forward = decideCluster(rows)!;
    const reversed = decideCluster(rows.toReversed())!;
    expect(forward.keptId).toBe(reversed.keptId);
    // Same bytes, same pixels — the EARLIEST capture wins, because of two
    // identical copies the first one taken is the original.
    expect(forward.keptId).toBe("b");
  });

  it("lets the member override the proposal, and recounts around it", () => {
    const assets = [
      copy("big", { byte_size: 4_100_000 }),
      copy("small", { byte_size: 820_000, width: 1600, height: 1200 }),
    ];
    const overridden = decideCluster(assets, "small")!;
    expect(overridden.keptId).toBe("small");
    expect(overridden.trashIds).toStrictEqual(["big"]);
    // The member kept the smaller copy, so `largest` is no longer true of it.
    expect(overridden.reason).toBeNull();
  });

  it("falls back to the proposal when the override names no live copy", () => {
    const assets = [copy("a", { byte_size: 2 }), copy("b", { byte_size: 1 })];
    expect(decideCluster(assets, "gone-to-trash")!.keptId).toBe("a");
  });

  it("has nothing to decide about an empty cluster", () => {
    expect(decideCluster([])).toBeNull();
  });
});

describe("what the review promises before it trashes anything", () => {
  const cluster: Cluster = {
    key: "c2",
    assets: [
      copy("keep", { byte_size: 4_100_000 }),
      copy("dupe", { byte_size: 4_000_000 }),
      copy("small", { byte_size: 820_000, width: 1600, height: 1200 }),
    ],
  };

  it("states the count it will destroy in the title, the body and the act", () => {
    const html = review(cluster);
    expect(html).toContain("2 copies to trash");
    expect(html).toContain("The other 2 go to trash for 30 days.");
    expect(html).toContain("Trash 2 copies");
  });

  it("says what survives, not only what goes", () => {
    expect(review(cluster)).toContain(
      "The copy you keep stays in every album it is already in, and keeps its caption."
    );
  });

  it("gets the grammar right when exactly one copy would go", () => {
    const pair: Cluster = {
      key: "c1",
      assets: [copy("keep", { byte_size: 9 }), copy("dupe", { byte_size: 1 })],
    };
    const html = review(pair);
    expect(html).toContain("One copy to trash");
    expect(html).toContain("The other copy goes to trash for 30 days.");
    expect(html).toContain("Trash 1 copy");
    expect(html).toContain("Keep all 2");
  });

  it("marks exactly one copy `keep` and every other one `trash`", () => {
    const html = review(cluster);
    expect([...html.matchAll(/>keep · largest</gu)]).toHaveLength(1);
    // Once on the tile's state slot and once in the readout row, per copy.
    expect([...html.matchAll(/>trash</gu)]).toHaveLength(4);
  });

  it("moves the keep when the member overrides it", () => {
    const html = review(cluster, { keptId: "small" });
    expect(html).toContain("2 copies to trash");
    // The smaller copy is not the largest, so the reason word is gone with it.
    expect(html).not.toContain("keep · largest");
    expect([...html.matchAll(/>keep</gu)]).toHaveLength(2);
  });

  it("places the member in the queue without inventing a step past the end", () => {
    expect(review(cluster)).toContain("Cluster 2 of 6");
    expect(review(cluster)).toContain(
      "cluster 2 of 6 · 4 clusters after this one"
    );
    const last = review(cluster, { index: 5, total: 6 });
    expect(last).toContain("cluster 6 of 6");
    expect(last).not.toContain("after this one");
    const penultimate = review(cluster, { index: 4, total: 6 });
    expect(penultimate).toContain("1 cluster after this one");
  });

  it("prints the window only when every copy carries a timestamp", () => {
    const timed: Cluster = {
      key: "c",
      assets: [
        copy("a", { taken_at: "2026-03-11T09:00:00.000Z", byte_size: 2 }),
        copy("b", { taken_at: "2026-03-11T09:00:02.000Z", byte_size: 1 }),
      ],
    };
    expect(review(timed)).toContain("2 near-identical · within 2 seconds");
    const untimed: Cluster = {
      key: "c",
      assets: [copy("a", { byte_size: 2 }), copy("b", { taken_at: null })],
    };
    const html = review(untimed);
    expect(html).toContain("2 near-identical");
    expect(html).not.toContain("within");
  });

  it("prints the facts a copy recorded and no clause it did not", () => {
    const html = review(cluster);
    expect(html).toContain("4032 × 3024");
    expect(html).toContain("1600 × 1200");
    // No provenance column exists on a cluster row, so the prototype's
    // `· from this phone` clause is omitted rather than guessed.
    expect(html).not.toContain("from this phone");
  });

  it("goes inert while the batch runs, without becoming a spinner", () => {
    const html = renderToStaticMarkup(
      createElement(DuplicateReviewView, {
        cluster,
        index: 1,
        total: 6,
        rung: 1,
        keptId: null,
        busy: true,
        onKeep: () => {},
        onTrashRest: () => {},
        onKeepAll: () => {},
      })
    );
    expect([...html.matchAll(/disabled/gu)].length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Trash 2 copies");
  });

  it("never fills the destructive act (§18)", () => {
    expect(review(cluster)).not.toContain("kit-btn primary");
  });
});
