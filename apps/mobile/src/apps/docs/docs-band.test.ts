// The claimed band's model rules (handoff Part 2 §"The band"; issue #821).
import { describe, expect, it } from "vitest";

import { MORE_ROWS } from "@centraid/blueprints/apps/docs/view-copy";

import {
  DOCS_BAND_DESTINATIONS,
  DOCS_BAND_MAX_DESTINATIONS,
  DOCS_MORE_ROWS,
  resolveDocsBand,
  resolveDocsMoreRoute,
} from "./docs-band";
import type { DocsMoreRowKey } from "./docs-band";

describe("docs band", () => {
  it("claims exactly five destinations — the invariant's exact cap — with the handoff's own words, More last", () => {
    expect(DOCS_BAND_DESTINATIONS).toHaveLength(DOCS_BAND_MAX_DESTINATIONS);
    expect(DOCS_BAND_DESTINATIONS.map((d) => d.label)).toStrictEqual([
      "All",
      "Folders",
      "Coming due",
      "Search",
      "More",
    ]);
    expect(DOCS_BAND_DESTINATIONS.at(-1)?.key).toBe("more");
  });

  it("resolves to the app's band by default and to the bare capsule when handed back", () => {
    const claimed = resolveDocsBand("app");
    // The capsule is a frame control OUTSIDE the tab group — structural,
    // not cosmetic.
    expect(claimed).toMatchObject({
      owner: "app",
      capsule: { inTabGroup: false, size: 52 },
    });
    expect(resolveDocsBand("host")).toStrictEqual({ owner: "host" });
  });

  it("lists the handoff's six More-sheet shelves, in its order, with the shared table's labels", () => {
    expect(DOCS_MORE_ROWS.map((row) => row.label)).toStrictEqual([
      "Recently changed",
      "Starred",
      "Trash",
      "Storage",
      "What Docs may read",
      "Add a document",
    ]);
    // Labels come FROM the shared table, so the sheet cannot drift from web.
    for (const row of DOCS_MORE_ROWS) {
      expect(MORE_ROWS.some((shared) => shared.label === row.label)).toBe(true);
    }
  });

  it("routes every More row to a real Docs screen", () => {
    const expected: Record<DocsMoreRowKey, string> = {
      recent: "DocsRecent",
      starred: "DocsStarred",
      trash: "DocsTrash",
      storage: "DocsStorage",
      capabilities: "DocsCapabilities",
      add: "DocsAdd",
    };
    for (const row of DOCS_MORE_ROWS) {
      expect(resolveDocsMoreRoute(row.key)).toBe(expected[row.key]);
    }
  });
});
