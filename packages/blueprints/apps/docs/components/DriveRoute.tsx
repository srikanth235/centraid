// Docs DRIVE route body (§4–5): the row set every drive shelf paints.
// Stateless; routing and the size allowance stay in `app-root.tsx`.
import { useMemo, useRef } from "react";
import type { ReactNode } from "react";

import { uniformModel } from "../../_shared/virtual-window.ts";
import {
  useMeasuredBlockHeight,
  useScrollHost,
  useVirtualWindow,
  VirtualSpacer,
} from "../../_shared/VirtualWindow.tsx";
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
  search: string;
  trashed: boolean;
  /** Gateway out of reach (view-state.ts). */
  offline: boolean;
  filters: DriveFilters;
  /** Rows BEFORE filtering, so picking an audience cannot remove its pill. */
  filterRows: readonly DriveDoc[];
  onSelectFilter: (axis: keyof DriveFilters, option: string | null) => void;
  onClearFilters: () => void;
  caption: string | null;
  empty: EmptyStateView;
  emptyRunFor: (label: string) => (() => void) | undefined;
  selectedIds: Set<string>;
  driveWindow: number;
  showFoot: boolean;
  /** The read for rows beyond the window FAILED, rather than in flight. */
  windowFailed: boolean;
  folderName: (id: string | null | undefined) => string;
  onOpenDetails: (id: string) => void;
  onOpenQuick: (id: string) => void;
  onToggleSelect: (id: string, index: number, shift: boolean) => void;
  onToggleAll: (rows: DriveDoc[], allSelected: boolean) => void;
  onOpenMenu: (anchor: HTMLElement, doc: DriveDoc) => void;
  onRestore: (doc: DriveDoc) => void;
  onShowMore: () => void;
  /** Column heads ARE the sort control (ListHead). */
  sortKey: SortKey;
  sortDir: 1 | -1;
  onSortBy: (key: SortKey) => void;
  onOpenSortMenu: (anchor: HTMLElement) => void;
  /** Selection MODE, entered by app-bar Select (§4.1). */
  selecting: boolean;
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
        {/* Header is POINTER ONLY (§13): folded into row snippets on touch. */}
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
        <WindowedRows {...props} />
      </div>
      {foot}
    </>
  );
}

/**
 * The drive's row set, WINDOWED (#883 C4). One `--density-row` rung tall per
 * row, so the geometry is arithmetic and the first rendered row is measured
 * for the tier's real number.
 *
 * A row's `index` is its index in `props.rows`, NOT in the window: shift
 * range-select and the "first row" rule are about the set, not about what
 * happens to be mounted.
 */
function WindowedRows(props: DriveRouteProps): ReactNode {
  const listRef = useRef<HTMLUListElement | null>(null);
  const scrollRef = useScrollHost(listRef);
  const rowHeight = useMeasuredBlockHeight(listRef, ROW_RUNG_FALLBACK);
  const model = useMemo(
    () => uniformModel(props.rows.length, rowHeight),
    [props.rows.length, rowHeight]
  );
  const slice = useVirtualWindow({ model, scrollRef, listRef });
  const total = props.rows.length;

  return (
    <ul className={driveStyles.rowList} ref={listRef}>
      <VirtualSpacer height={slice.padStart} as="li" />
      {props.rows.slice(slice.start, slice.end).map((d, offset) => {
        const index = slice.start + offset;
        return (
          <ListRow
            key={d.document_id}
            doc={d}
            index={index}
            position={{ setSize: total }}
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
        );
      })}
      <VirtualSpacer height={slice.padEnd} as="li" />
    </ul>
  );
}

const ROW_RUNG_FALLBACK = 44;

export function DriveRoute(props: DriveRouteProps): ReactNode {
  return (
    <>
      <Breadcrumb
        crumbs={props.crumbs}
        menu={PLACE_MENU}
        onSelectShelf={props.onSelectShelf}
      />
      {/* No filters while empty for a reason the filters did not cause. */}
      {props.empty.visible && props.empty.variant !== "filter" ? null : (
        <FilterRow
          filters={props.filters}
          rows={props.filterRows}
          onSelect={props.onSelectFilter}
          onClear={props.onClearFilters}
        />
      )}
      <DriveBody {...props} />
      {/* Never a sentence on a row — the caption carries prose once (§4.1). */}
      {props.caption && !props.empty.visible ? (
        <p className={driveStyles.caption}>{props.caption}</p>
      ) : null}
      {isTrash(props.shelf) ? <TrashAsk /> : null}
    </>
  );
}
