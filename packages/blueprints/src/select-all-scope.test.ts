// @vitest-environment jsdom
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  pruneSelection,
  toggleAllSelection,
} from "../apps/_shared/selection-engine.ts";

const docsApp = (rel: string): string =>
  pathToFileURL(path.resolve(import.meta.dirname, "../apps/docs", rel)).href;

interface Doc {
  document_id: string;
  title: string;
  starred?: boolean;
  folder_id?: string | null;
  deleted_at?: string | null;
  created_at?: string;
}

interface DocsLogic {
  currentRows: () => Doc[];
  toggleAllVisible: (rows: Doc[], allSelected: boolean) => void;
  selectedDocs: () => Doc[];
  pruneVisibleSelection: () => void;
}

const { createLogic } = (await import(docsApp("logic.ts"))) as {
  createLogic: (deps: Record<string, unknown>) => DocsLogic;
};

const DOCS: Doc[] = [
  { created_at: "2026-01-01", document_id: "a", starred: true, title: "A" },
  { created_at: "2026-01-02", document_id: "b", starred: true, title: "B" },
  { created_at: "2026-01-03", document_id: "c", starred: false, title: "C" },
  { created_at: "2026-01-04", document_id: "d", starred: false, title: "D" },
];

function drive() {
  const state = {
    anchorIndex: null as number | null,
    driveTruncated: false,
    driveWindow: 100,
    filters: {
      modified: null,
      people: null,
      source: null,
      type: null,
    },
    narrow: false,
    search: "",
    searchResults: null,
    selected: new Set<string>(),
    selecting: true,
    shelf: null as string | null,
    sortDir: 1,
    sortKey: "name",
    tag: "all",
    visibleRows: [] as Doc[],
  };
  const data = {
    documents: DOCS,
    folders: [],
    root_folder_id: null,
  };
  const logic = createLogic({
    data,
    openDetails: () => {},
    openQuick: () => {},
    openVersions: () => {},
    refresh: () => {},
    render: () => {},
    state,
  });
  const paint = (): Doc[] => {
    state.visibleRows = logic.currentRows();
    logic.pruneVisibleSelection();
    return state.visibleRows;
  };
  return { logic, paint, state };
}

describe("[law:select-all-filtered] docs — the drive's select-all is the filtered set", () => {
  it("selects the rows the shelf is showing, not the table behind it", () => {
    const { logic, paint, state } = drive();
    state.shelf = "built-in:starred";
    const rows = paint();
    expect(rows.map((row) => row.document_id)).toStrictEqual(["a", "b"]);

    logic.toggleAllVisible(rows, false);

    expect([...state.selected].toSorted()).toStrictEqual(["a", "b"]);
    expect(logic.selectedDocs().map((row) => row.document_id)).toStrictEqual([
      "a",
      "b",
    ]);
  });

  it("prunes a selection the next filter no longer shows", () => {
    const { logic, paint, state } = drive();
    state.shelf = "built-in:starred";
    logic.toggleAllVisible(paint(), false);
    expect(state.selected.size).toBe(2);

    state.shelf = "built-in:trash";
    expect(paint()).toStrictEqual([]);

    expect([...state.selected]).toStrictEqual([]);
    expect(logic.selectedDocs()).toStrictEqual([]);
    expect(state.anchorIndex).toBeNull();
  });

  it("keeps the keys that survived, and only those", () => {
    const { logic, paint, state } = drive();
    const all = paint();
    logic.toggleAllVisible(all, false);
    expect(state.selected.size).toBe(4);

    state.shelf = "built-in:starred";
    paint();

    expect([...state.selected].toSorted()).toStrictEqual(["a", "b"]);
  });

  it("never reports a selected row the member cannot see", () => {
    const { logic, paint, state } = drive();
    paint();
    state.selected.add("ghost");
    paint();
    expect(logic.selectedDocs().map((row) => row.document_id)).not.toContain(
      "ghost"
    );
  });
});

describe("[law:select-all-filtered] the engine photos calls answers the same two halves", () => {
  const visible = ["v1", "v2", "v3"];

  it("select-all takes the visible keys and nothing else", () => {
    expect(
      [...toggleAllSelection(new Set(), visible)].toSorted()
    ).toStrictEqual(visible);
  });

  it("a live selection toggles to none rather than widening", () => {
    expect([...toggleAllSelection(new Set(["v1"]), visible)]).toStrictEqual([]);
  });

  it("pruning drops the keys the new filter does not show", () => {
    expect([...pruneSelection(new Set(visible), ["v2"])]).toStrictEqual(["v2"]);
  });
});
