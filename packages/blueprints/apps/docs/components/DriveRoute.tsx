// The DRIVE route body (Docs spec §4, §5) — the document row set and its
// grid, which every drive shelf paints: All, one folder, Recently changed,
// Starred, Search and Trash.
//
// This is one of three route bodies carved out of `app-root.tsx` so that the
// orchestrator holds ROUTING and the components hold SCREENS. `app-root.tsx`
// already carries an explicit governance allowance for its size under the
// oxlint file-size cap, and a route body inlined there would grow it further —
// a route body belongs in a component.
//
// THE BLOCK SEQUENCE IS THE SPEC'S (§4.3): breadcrumb → filter row → row set
// (or the empty block that stands in for it) → caption → the shelf's own
// trailing panel. Every drive shelf is the SAME screen under a filter, so there
// is one sequence here and not six. The offline banner is NOT in this list: it
// is one panel for the whole app, drawn above every route body by app-root.tsx,
// exactly as §4.3's own state panels stand above the breadcrumb.
//
// It owns no state. Everything it draws is a function of its props, so the
// same rows render identically from a fresh read, a doorbell refresh or a
// server render in a test.
import type { ReactNode } from "react";

import { PLACE_MENU } from "../drive-copy.ts";
import type { Crumb } from "../drive-copy.ts";
import type { DriveFilters } from "../filters.ts";
import { isTrash } from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import type { DriveDoc, SortKey } from "../types.ts";
import type { EmptyStateView } from "../view-state.ts";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { FilterRow } from "./FilterRow.tsx";
import { GridCard } from "./Grid.tsx";
import { ListHead, ListRow, WindowFoot } from "./List.tsx";
import type { DriveOwner } from "./List.tsx";
import { TrashAsk } from "./TrashAsk.tsx";

import styles from "../Chrome.module.css";
import driveStyles from "./DriveRoute.module.css";

export interface DriveRouteProps {
  shelf: ShelfId;
  crumbs: readonly Crumb[];
  onSelectShelf: (shelf: ShelfId) => void;
  rows: DriveDoc[];
  view: "grid" | "list";
  narrow: boolean;
  /** The live query, so a row can carry its snippet. */
  search: string;
  /** Rows are in Trash — the row menu and the date column change with it. */
  trashed: boolean;
  /** The gateway is out of reach (view-state.ts `libraryReachability`). The
   *  banner itself is the orchestrator's — one per app, not one per route body
   *  — so what this changes here is the caption and what a row may promise. */
  offline: boolean;
  filters: DriveFilters;
  /** The set the filter row derives its People options from: this drive's rows
   *  BEFORE any filter narrows them, so picking an audience cannot remove the
   *  pill that was picked. */
  filterRows: readonly DriveDoc[];
  onSelectFilter: (axis: keyof DriveFilters, option: string | null) => void;
  onClearFilters: () => void;
  /** The closing sentence under the set (§4.1) — `captionFor`'s answer, or
   *  null where this app cannot yet compute the number the caption names. */
  caption: string | null;
  /** Nothing to show, and what may be said about it (§4.6). */
  empty: EmptyStateView;
  emptyRunFor: (label: string) => (() => void) | undefined;
  selectedIds: Set<string>;
  driveWindow: number;
  /** More rows exist beyond the fetched window (§4.1's loading window). */
  showFoot: boolean;
  /** The read for the rows beyond the window came back FAILED, rather than
   *  still being in flight — the one thing rung 1 of the state ladder says. */
  windowFailed: boolean;
  folderName: (id: string | null | undefined) => string;
  onOpenDetails: (id: string) => void;
  onOpenQuick: (id: string) => void;
  onToggleSelect: (id: string, index: number, shift: boolean) => void;
  onToggleAll: (rows: DriveDoc[], allSelected: boolean) => void;
  onOpenMenu: (anchor: HTMLElement, doc: DriveDoc) => void;
  onRestore: (doc: DriveDoc) => void;
  onShowMore: () => void;
  /** The drive's order, and the head that sets it — the column heads ARE the
   *  sort control (List.tsx `ListHead`). */
  sortKey: SortKey;
  sortDir: 1 | -1;
  onSortBy: (key: SortKey) => void;
  onOpenSortMenu: (anchor: HTMLElement) => void;
  /** Selection is a MODE, entered by the app bar's Select (§4.1). */
  selecting: boolean;
  /** Who the rows belong to, as this drive can answer it. */
  owner: DriveOwner;
}

function DriveBody(props: DriveRouteProps): ReactNode {
  const foot = props.showFoot ? (
    <WindowFoot
      driveWindow={props.driveWindow}
      failed={props.windowFailed}
      onShowMore={props.onShowMore}
    />
  ) : null;

  if (props.empty.visible) {
    return <EmptyState view={props.empty} runFor={props.emptyRunFor} />;
  }

  if (props.view === "grid") {
    return (
      <>
        <div className={styles.grid}>
          {props.rows.map((d, i) => (
            <GridCard
              key={d.document_id}
              doc={d}
              index={i}
              offline={props.offline}
              trashed={props.trashed}
              selectedIds={props.selectedIds}
              selecting={props.selecting}
              onOpenDetails={props.onOpenDetails}
              onOpenQuick={props.onOpenQuick}
              onToggleSelect={props.onToggleSelect}
            />
          ))}
        </div>
        {foot}
      </>
    );
  }

  return (
    <>
      <div className={styles.listwrap}>
        {/* The header row is POINTER ONLY (§13): on touch its five columns are
            folded into the row's own snippet line, so a hidden header would be
            describing a state that cannot occur. */}
        {props.narrow ? null : (
          <div className={styles.listHead}>
            <ListHead
              rows={props.rows}
              selectedIds={props.selectedIds}
              selecting={props.selecting}
              onToggleAll={props.onToggleAll}
              sortKey={props.sortKey}
              sortDir={props.sortDir}
              onSortBy={props.onSortBy}
              onOpenSortMenu={props.onOpenSortMenu}
            />
          </div>
        )}
        <div>
          {props.rows.map((d, i) => (
            <ListRow
              key={d.document_id}
              doc={d}
              index={i}
              selectedIds={props.selectedIds}
              selecting={props.selecting}
              owner={props.owner}
              narrow={props.narrow}
              search={props.search}
              trashed={props.trashed}
              offline={props.offline}
              folderName={props.folderName}
              onOpenDetails={props.onOpenDetails}
              onOpenQuick={props.onOpenQuick}
              onToggleSelect={props.onToggleSelect}
              onOpenMenu={props.onOpenMenu}
              onRestore={props.onRestore}
            />
          ))}
        </div>
      </div>
      {foot}
    </>
  );
}

export function DriveRoute(props: DriveRouteProps): ReactNode {
  return (
    <>
      <Breadcrumb
        crumbs={props.crumbs}
        menu={PLACE_MENU}
        onSelectShelf={props.onSelectShelf}
      />
      {/* Nothing to filter while the set is empty for a reason the filters did
          not cause — a first-run drive or an empty shelf. */}
      {props.empty.visible && props.empty.variant !== "filter" ? null : (
        <FilterRow
          filters={props.filters}
          rows={props.filterRows}
          onSelect={props.onSelectFilter}
          onClear={props.onClearFilters}
        />
      )}
      <DriveBody {...props} />
      {/* "Never a sentence on a row: the caption under the set carries the
          prose, once." (§4.1, verbatim.) */}
      {props.caption && !props.empty.visible ? (
        <p className={driveStyles.caption}>{props.caption}</p>
      ) : null}
      {isTrash(props.shelf) ? <TrashAsk /> : null}
    </>
  );
}
