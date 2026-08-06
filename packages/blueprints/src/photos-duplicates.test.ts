// @vitest-environment jsdom
// The Duplicates shelf's member-facing copy and cluster header (issue #711
// review, v4 handoff proto :4437-:4439):
//
//   1. NO ISSUE ID EVER REACHES A MEMBER. The shelf used to print
//      "(issue #352)" in its own lede — an implementation detail, not
//      something a member reads. Sabotage-verified below: re-adding any
//      `#<digits>` to the shelf's rendered copy fails this file.
//   2. EACH CLUSTER IS LABELLED, not one undifferentiated paragraph per row:
//      an ordinal, a count, and an honestly-derived "why we think so" meta —
//      the time window and the per-copy size — omitted rather than invented
//      when the rows do not carry the fact.
//
// Rendered to static markup, like every other pure-view fixture in this
// package (photos-shelves-v4.test.ts): these are pure views over props, so
// the markup IS the behaviour.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createElement } from "react";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const app = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/photos", rel)).href;

interface ClusterAsset {
  asset_id: string;
  width: number;
  height: number;
  taken_at?: string | null;
  byte_size?: number | null;
}
interface Cluster {
  key: string;
  assets: ClusterAsset[];
}

const { DuplicatesView } = (await import(app("components/Duplicates.tsx"))) as {
  DuplicatesView: ComponentType<{
    clusters: Cluster[] | null;
    loading: boolean;
    rung?: number;
    selected: Set<string>;
    onToggle: (assetId: string) => void;
    onTrashSelected: () => void;
  }>;
};
const { duplicatesLede } = (await import(app("view-copy.ts"))) as {
  duplicatesLede: (clusterCount: number) => string;
};

const tile = (id: string, extra: Partial<ClusterAsset> = {}): ClusterAsset => ({
  asset_id: id,
  width: 100,
  height: 100,
  ...extra,
});

const render = (clusters: Cluster[]): string =>
  renderToStaticMarkup(
    createElement(DuplicatesView, {
      clusters,
      loading: false,
      selected: new Set<string>(),
      onToggle: () => {},
      onTrashSelected: () => {},
    })
  );

describe("Duplicates never names the issue that shipped it", () => {
  it("carries no issue id in the lede for any cluster count", () => {
    expect(duplicatesLede(1)).not.toMatch(/#\d+/u);
    expect(duplicatesLede(6)).not.toMatch(/#\d+/u);
  });

  it("carries no issue id anywhere in the rendered shelf", () => {
    const html = render([
      { key: "c1", assets: [tile("a"), tile("b"), tile("c")] },
    ]);
    expect(html).not.toMatch(/#\d+/u);
    expect(html).not.toContain("issue");
  });

  it("gets the grammar right for exactly one cluster", () => {
    expect(duplicatesLede(1)).toBe(
      "1 cluster of near-identical photographs. Selecting a copy marks it for trash; the one you keep stays where it is, in the album and the timeline it is already in."
    );
    expect(duplicatesLede(6)).toContain("6 clusters of near-identical");
  });
});

describe("each cluster is its own labelled header", () => {
  it("numbers clusters by their position, not a stable id", () => {
    const html = render([
      { key: "z9", assets: [tile("a"), tile("b")] },
      { key: "a1", assets: [tile("c"), tile("d"), tile("e")] },
    ]);
    expect(html).toContain("Cluster 1 · 2 near-identical");
    expect(html).toContain("Cluster 2 · 3 near-identical");
  });

  it("derives the time window only when every copy carries one", () => {
    const complete = render([
      {
        key: "c1",
        assets: [
          tile("a", { taken_at: "2026-01-01T00:00:00.000Z" }),
          tile("b", { taken_at: "2026-01-01T00:00:02.000Z" }),
        ],
      },
    ]);
    expect(complete).toContain("within 2 seconds");

    const partial = render([
      {
        key: "c1",
        assets: [
          tile("a", { taken_at: "2026-01-01T00:00:00.000Z" }),
          tile("b"), // no timestamp — the window is not knowable, not zero
        ],
      },
    ]);
    expect(partial).not.toContain("within");
  });

  it("derives the per-copy size only when every copy carries one", () => {
    const complete = render([
      {
        key: "c1",
        assets: [
          tile("a", { byte_size: 4_100_000 }),
          tile("b", { byte_size: 4_100_000 }),
        ],
      },
    ]);
    expect(complete).toContain("each");

    const partial = render([
      {
        key: "c1",
        assets: [tile("a", { byte_size: 4_100_000 }), tile("b")],
      },
    ]);
    expect(partial).not.toContain("each");
  });

  it("omits the meta line entirely rather than inventing half of it", () => {
    const html = render([{ key: "c1", assets: [tile("a"), tile("b")] }]);
    expect(html).toContain("Cluster 1 · 2 near-identical");
    expect(html).not.toContain("within");
    expect(html).not.toContain("each");
  });
});
