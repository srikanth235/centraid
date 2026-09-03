// The claimed band's model rules (handoff Part 2 §"The band"; #821).
import { describe, expect, it } from "vitest";

import { MORE_ROWS } from "@centraid/blueprints/apps/docs/view-copy";

import {
  DOCS_BAND_DESTINATIONS,
  DOCS_BAND_MAX_DESTINATIONS,
  DOCS_MORE_ROWS,
  DOCS_MORE_SHEET_ROWS,
  resolveDocsBand,
  resolveDocsMoreRoute,
} from "./docs-band";
import type { DocsMoreRowKey } from "./docs-band";

describe("docs band", () => {
  it("stays within the five-destination cap, with More last", () => {
    expect(DOCS_BAND_DESTINATIONS.length).toBeLessThanOrEqual(
      DOCS_BAND_MAX_DESTINATIONS
    );
    expect(DOCS_BAND_DESTINATIONS.map((d) => d.label)).toStrictEqual([
      "All",
      "Folders",
      "Starred",
      "Shared",
      "More",
    ]);
    expect(DOCS_BAND_DESTINATIONS.at(-1)?.key).toBe("more");
  });

  it("puts Search first on the More sheet, ahead of Coming due", () => {
    expect(
      DOCS_MORE_SHEET_ROWS.map((row) => row.key).slice(0, 2)
    ).toStrictEqual(["search", "due"]);
    expect(DOCS_MORE_ROWS.some((row) => row.label === "Search")).toBe(false);
  });

  it("keeps Starred off the More sheet now that it is a band destination", () => {
    expect(DOCS_MORE_ROWS.some((row) => row.label === "Starred")).toBe(false);
  });

  it("resolves to the app's band by default and to the bare capsule when handed back", () => {
    const claimed = resolveDocsBand("app");
    expect(claimed).toMatchObject({
      owner: "app",
      capsule: { inTabGroup: false, size: 52 },
    });
    expect(resolveDocsBand("host")).toStrictEqual({ owner: "host" });
  });

  it("lists the remaining More-sheet shelves, in the handoff's order, with the shared table's labels", () => {
    expect(DOCS_MORE_ROWS.map((row) => row.label)).toStrictEqual([
      "Recently changed",
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
    const expected: Record<
      Exclude<DocsMoreRowKey, "due" | "search">,
      string
    > = {
      recent: "DocsRecent",
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
