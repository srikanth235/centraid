// The selection bar (v4 handoff §6): the toolbar row's OWN content while a
// selection is active — count, five actions in a fixed order, Select
// all/none, Done. Two arrangements of the SAME data, exactly like the
// viewer's ViewerBarActions/ViewerBottomBar split (ViewerActions.tsx):
//
//   * `SelectionBarView` — desktop/PWA. A row whose actions carry a visible
//     label once the bar itself is at least `LABEL_BREAKPOINT` wide
//     (measured by the caller — selection.tsx owns the ResizeObserver — and
//     handed in as `labelled`, never re-derived from a surface flag here).
//   * `SelectionBottomBar` — the phone's bottom bar of five 56px targets.
//     Always icon + small caption; the count, Select all and Done stay in the
//     frame's head on that surface (out of this file's reach — see the
//     integration note below).
//
// `buildSelectionActions` is the one place the fixed order and the Trash
// shelf's swap (Trash → Restore) live, as a pure function of shelf +
// read-only state — both view components and the tests read the same table,
// so the order can't drift between them. The third target is *Share* (#825):
// it opens the ONE grant kit over the selected photograph, so the bar carries
// no destination list, no scope reading and no share call of its own.
//
// INTEGRATION NOTE (not this file's to fix): `SelectionBarView` is rendered
// into the app's `#selectionBar` overlay region (Chrome.tsx), not literally
// inside the toolbar row's own DOM node — that seam belongs to whoever wires
// Chrome.tsx/app-root.tsx, both off limits to this change. `shelfKind` and
// `readOnlyReason` likewise need the current shelf and the selected assets'
// write grants, which only app-root.tsx's closure holds; selection.tsx
// exposes optional getters for both so wiring them up later is additive.
// `SelectionBottomBar` is written and tested but not yet mounted anywhere —
// the phone band is Chrome.tsx's to claim.
import { useRef } from "react";
import type { FC } from "react";

import { armConfirm } from "@centraid/design/elements";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { buildSelectionActions as buildSharedSelectionActions } from "../../_shared/selection-engine.ts";
import type { SelectionShelfKind } from "../../_shared/selection-engine.ts";
import { ONE_AT_A_TIME, usePhotoShare } from "../grant-audiences.ts";
import {
  SelectAlbumIcon,
  SelectDownloadIcon,
  SelectFavoriteIcon,
  SelectRestoreIcon,
  SelectShareIcon,
  SelectTrashIcon,
} from "../icons.tsx";
import { notice, writeTarget } from "../outcomes.ts";
import {
  runBatchAddToAlbum,
  runBatchDelete,
  runBatchDownload,
  runBatchFavorite,
  runBatchRestore,
} from "../selection-actions.ts";
import type { Album, Asset } from "../types.ts";

import styles from "./SelectionBar.module.css";

/** Below this many pixels OF BAR the actions go icon-only (§6, §15). A
 *  function of the bar's own measured width, never of which surface this is —
 *  the PWA's narrower bar crosses it well above a phone's; a bare viewport
 *  breakpoint would get both wrong. */
export const LABEL_BREAKPOINT = 840;

/** Are the bar's actions labelled at this measured width? */
export function labelsVisible(barWidth: number): boolean {
  return barWidth >= LABEL_BREAKPOINT;
}

export type { SelectionShelfKind } from "../../_shared/selection-engine.ts";

export interface SelectionActionSpec {
  id: "favorite" | "add-to-album" | "share" | "download" | "trash";
  label: string;
  icon: FC<{ size?: number }>;
  onRun: () => void;
  disabled: boolean;
  /** Why it is disabled — a read-only vault states this on the control
   *  itself, never only in a tooltip (§6, §18). */
  reason?: string;
  /** An outlined `--net` button, never filled (§18) — Trash only; Restore
   *  undoes a destructive action rather than being one. */
  destructive?: boolean;
  /** Asks for a second tap on the same control before it fires (armConfirm),
   *  the wording naming exactly what will happen. Trash only. */
  confirmLabel?: string;
}

export interface BuildSelectionActionsInput {
  count: number;
  shelfKind: SelectionShelfKind;
  /** The third target's caption — `Copy to ⟨label⟩`, or the resting caption
   *  while no single destination exists (sharing.ts's `copyActionLabel`). */
  copyLabel: string;
  /** Non-null in a read-only vault (§6): Favorite, Add to album and
   *  Trash/Restore disable with this reason; *Copy to ⟨vault⟩* and Download
   *  do not — copying into a vault the member owns, and downloading, are
   *  never writes on someone else's library. */
  readOnlyReason: string | null;
  /**
   * Why *Copy to ⟨vault⟩* cannot fire — no other writable scope is mounted
   * here, or several are and this control cannot yet ask which (issue #726).
   * Null when exactly one destination exists. The control DISABLES with this
   * sentence on it rather than being tappable and doing nothing.
   */
  copyBlockedReason: string | null;
  onFavorite: () => void;
  onAddToAlbum: () => void;
  onShare: () => void;
  onDownload: () => void;
  onTrash: () => void;
}

/**
 * The five actions, in the handoff's fixed order, with the Trash shelf's swap
 * applied (§6). Pure — no DOM, no React — so the order, the swap and the
 * disabled/reason state are all directly testable without rendering anything.
 */
export function buildSelectionActions({
  count,
  shelfKind,
  copyLabel,
  readOnlyReason,
  copyBlockedReason: copyBlocked,
  onFavorite,
  onAddToAlbum,
  onShare,
  onDownload,
  onTrash,
}: BuildSelectionActionsInput): SelectionActionSpec[] {
  const iconByKey: Record<string, FC<{ size?: number }>> = {
    album: SelectAlbumIcon,
    download: SelectDownloadIcon,
    heart: SelectFavoriteIcon,
    restore: SelectRestoreIcon,
    share: SelectShareIcon,
    trash: SelectTrashIcon,
  };
  const share = copyBlocked
    ? { unavailableReason: copyBlocked }
    : { run: onShare };
  return buildSharedSelectionActions({
    count,
    shelf: shelfKind,
    copyLabel,
    readOnlyReason,
    favorite: { run: onFavorite },
    addToAlbum: { run: onAddToAlbum },
    share,
    download: { run: onDownload },
    trash: { run: onTrash },
  }).map((action) => ({
    id: action.id,
    label: action.label,
    icon: iconByKey[action.icon] ?? SelectDownloadIcon,
    onRun: action.run,
    disabled: action.disabled,
    reason: action.reason,
    destructive: action.destructive,
    confirmLabel:
      action.id === "trash" && action.destructive
        ? `${action.label} ${count}?`
        : undefined,
  }));
}

function ActionButton({
  spec,
  labelled,
}: {
  spec: SelectionActionSpec;
  labelled: boolean;
}) {
  const Icon = spec.icon;
  return (
    <button
      type="button"
      className={`${styles.action} ${spec.destructive ? styles.destructive : ""}`}
      disabled={spec.disabled}
      aria-label={spec.label}
      // Labelled, the visible text IS the name, so `title` only ever carries
      // the disabled reason; icon-only, it doubles as the name for a pointer
      // that hovers and wonders (§6, §18 — every icon-only control is named).
      title={spec.reason ?? (labelled ? undefined : spec.label)}
      onClick={(e) => {
        if (
          spec.confirmLabel &&
          !armConfirm(e.currentTarget, { armedLabel: spec.confirmLabel })
        ) {
          return;
        }
        spec.onRun();
      }}
    >
      <Icon size={15} />
      {labelled ? (
        <span className={styles.actionLabel}>{spec.label}</span>
      ) : null}
    </button>
  );
}

export interface SelectionBarViewProps {
  selectedIds: Set<string>;
  /** The currently loaded rows — Download resolves each key's `content_uri`
   *  from here, and Select all/none walks the same list. */
  visible: readonly Asset[];
  albums: Album[];
  shelfKind: SelectionShelfKind;
  readOnlyReason: string | null;
  menuOpen: boolean;
  busy: boolean;
  /** Is the bar itself at least `LABEL_BREAKPOINT` wide? Measured by the
   *  caller (selection.tsx), never re-derived from a surface flag here. */
  labelled: boolean;
  refresh: () => Promise<void>;
  setBarBusy: (on: boolean) => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onExit: () => void;
  onToggleAll: () => void;
}

export function SelectionBarView({
  selectedIds,
  visible,
  albums: albumList,
  shelfKind,
  readOnlyReason,
  menuOpen,
  busy,
  labelled,
  refresh,
  setBarBusy,
  onToggleMenu,
  onCloseMenu,
  onExit,
  onToggleAll,
}: SelectionBarViewProps) {
  const count = selectedIds.size;
  const countRef = useRef<HTMLSpanElement>(null);
  const share = usePhotoShare(notice);
  const [only] = [...selectedIds];

  // countRef is passed as a REF, and the batch helpers dereference it only
  // inside their own event-time bodies; nothing reads `.current` during this
  // render — the compiler just cannot see through the call.
  // oxlint-disable-next-line react/react-compiler
  const actions = buildSelectionActions({
    count,
    shelfKind,
    // Who there is to share with is still the sheet's asynchronous question
    // (#726 P6) — the control never disables on a guess about the roster.
    // HOW MANY is not a guess, though: a grant stands over one subject, so a
    // multi-selection refuses here with the sentence that names the album.
    copyLabel: "Share",
    readOnlyReason,
    copyBlockedReason: count === 1 ? null : ONE_AT_A_TIME,
    onFavorite: () =>
      void runBatchFavorite([...selectedIds], countRef, {
        refresh,
        setBarBusy,
      }),
    onAddToAlbum: onToggleMenu,
    onShare: share.request,
    onDownload: () =>
      void runBatchDownload([...selectedIds], visible, countRef, {
        setBarBusy,
      }),
    onTrash: () => {
      if (shelfKind === "trash") {
        void runBatchRestore([...selectedIds], { refresh });
      } else {
        void runBatchDelete([...selectedIds], countRef, {
          refresh,
          setBarBusy,
          exitSelectMode: onExit,
        });
      }
    },
  });

  return (
    <>
      {only ? (
        <GrantSheet
          open={share.open}
          onClose={share.close}
          audiences={share.audiences}
          subject={{ subjectType: "media.asset", subjectId: only }}
          onStatus={notice}
        />
      ) : null}
      <span className={styles.count} ref={countRef}>
        {count}
      </span>
      <span className={styles.countLabel}>selected</span>
      <span className={styles.spacer} />
      {/* A real <fieldset>, not role="group": same semantics, native tag.
          The module strips the browser's fieldset chrome. */}
      <fieldset
        className={styles.actions}
        aria-label="Selection actions"
        aria-busy={busy || undefined}
      >
        {actions.map((spec) =>
          spec.id === "add-to-album" ? (
            <div key={spec.id} className={`bar-menu-wrap ${styles.menuWrap}`}>
              <ActionButton spec={spec} labelled={labelled} />
              {menuOpen ? (
                // kit-popover/kit-popover-item are the shared CSS classes; see
                // the original note this replaces — the away-click listener
                // lives in selection.tsx and queries `.bar-menu-wrap`.
                <div className={`kit-popover ${styles.albumMenu}`} role="menu">
                  {albumList.length === 0 ? (
                    <p className={`${styles.albumMenuEmpty} kit-muted`}>
                      No albums yet — make one from the chips above.
                    </p>
                  ) : (
                    albumList.map((album) => (
                      <button
                        key={album.album_id}
                        type="button"
                        className={`kit-popover-item ${styles.albumMenuItem}`}
                        role="menuitem"
                        onClick={() => {
                          onCloseMenu();
                          // Albums are own-scope regardless of the chip
                          // selection (albums-actions.ts) — resolved here,
                          // at the call site, so selection-actions.ts stays
                          // free of the outcomes.ts write-target import.
                          const target = writeTarget("own");
                          void runBatchAddToAlbum(
                            [...selectedIds],
                            album,
                            target.disabled ? null : target.scopeId,
                            countRef,
                            { refresh, setBarBusy, exitSelectMode: onExit }
                          );
                        }}
                      >
                        {album.title ?? "Album"}
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          ) : (
            <ActionButton key={spec.id} spec={spec} labelled={labelled} />
          )
        )}
      </fieldset>
      <button type="button" className={styles.selectAll} onClick={onToggleAll}>
        {count > 0 ? "Select none" : "Select all"}
      </button>
      <button type="button" className={styles.done} onClick={onExit}>
        Done
      </button>
      {readOnlyReason ? (
        <div className={styles.reason}>{readOnlyReason}</div>
      ) : null}
    </>
  );
}

export interface SelectionBottomBarProps {
  selectedIds: Set<string>;
  visible: readonly Asset[];
  shelfKind: SelectionShelfKind;
  readOnlyReason: string | null;
  refresh: () => Promise<void>;
  setBarBusy: (on: boolean) => void;
  onExit: () => void;
  /** The phone has no room for an inline popover; the caller supplies
   *  whatever picks an album there (a sheet, most likely) — not this file's
   *  layout to invent. */
  onAddToAlbum: () => void;
}

/**
 * The phone's bottom bar (§6, §D): five 56px targets, icon + small caption,
 * where a thumb is. Never measured for labels — at 390px there is no width
 * for six words either way, so every target names itself on the element.
 */
export function SelectionBottomBar({
  selectedIds,
  visible,
  shelfKind,
  readOnlyReason,
  refresh,
  setBarBusy,
  onExit,
  onAddToAlbum,
}: SelectionBottomBarProps) {
  const count = selectedIds.size;
  const share = usePhotoShare(notice);
  const [only] = [...selectedIds];
  const actions = buildSelectionActions({
    count,
    shelfKind,
    copyLabel: "Share",
    readOnlyReason,
    // One subject per grant, on this surface too — see `SelectionBarView`.
    copyBlockedReason: count === 1 ? null : ONE_AT_A_TIME,
    onFavorite: () =>
      void runBatchFavorite(
        [...selectedIds],
        { current: null },
        { refresh, setBarBusy }
      ),
    onAddToAlbum,
    onShare: share.request,
    onDownload: () =>
      void runBatchDownload(
        [...selectedIds],
        visible,
        { current: null },
        { setBarBusy }
      ),
    onTrash: () => {
      if (shelfKind === "trash") {
        void runBatchRestore([...selectedIds], { refresh });
      } else {
        void runBatchDelete(
          [...selectedIds],
          { current: null },
          {
            refresh,
            setBarBusy,
            exitSelectMode: onExit,
          }
        );
      }
    },
  });

  return (
    <>
      {only ? (
        <GrantSheet
          open={share.open}
          onClose={share.close}
          audiences={share.audiences}
          subject={{ subjectType: "media.asset", subjectId: only }}
          onStatus={notice}
        />
      ) : null}
      <div
        className={styles.bottomBar}
        role="toolbar"
        aria-label="Selection actions"
      >
        {actions.map((spec) => {
          const Icon = spec.icon;
          return (
            <button
              key={spec.id}
              type="button"
              className={`${styles.bottomAction} ${spec.destructive ? styles.destructive : ""}`}
              disabled={spec.disabled}
              aria-label={spec.label}
              // `title` names an icon-only control for a pointer that hovers
              // and wonders — it never carries the read-only STORY on its
              // own; that is the visible `.reason` line below (§6, §18: a
              // refusal is stated inline, never only in a tooltip).
              title={spec.reason ?? spec.label}
              onClick={(e) => {
                if (
                  spec.confirmLabel &&
                  !armConfirm(e.currentTarget, {
                    armedLabel: spec.confirmLabel,
                  })
                ) {
                  return;
                }
                spec.onRun();
              }}
            >
              <Icon size={18} />
              <span className={styles.bottomActionLabel}>{spec.label}</span>
            </button>
          );
        })}
      </div>
      {readOnlyReason ? (
        <div className={styles.reason}>{readOnlyReason}</div>
      ) : null}
    </>
  );
}

export interface PhoneAlbumSheetProps {
  albums: Album[];
  onPick: (album: Album) => void;
  onCancel: () => void;
}

/**
 * The phone's "Add to album" surface (§6): "the phone has no room for an
 * inline popover" (see the file header), so `SelectionBottomBar`'s Add to
 * album target opens this instead — a sheet-like list above the bottom bar,
 * dismissed by an explicit Cancel rather than a bare away-click (there is no
 * pointer to miss the target with on a touch surface). Picking an album and
 * the vault-write plumbing behind it are selection.tsx's job, same as the
 * desktop popover's — this component only says what the member tapped.
 */
export function PhoneAlbumSheet({
  albums,
  onPick,
  onCancel,
}: PhoneAlbumSheetProps) {
  return (
    <div className={styles.phoneSheet} role="menu" aria-label="Add to album">
      <div className={styles.phoneSheetHead}>
        <span className={styles.phoneSheetTitle}>Add to album</span>
        <button
          type="button"
          className={styles.phoneSheetCancel}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
      {albums.length === 0 ? (
        <p className={`${styles.albumMenuEmpty} kit-muted`}>
          No albums yet — make one from the chips above.
        </p>
      ) : (
        <div className={styles.phoneSheetList}>
          {albums.map((album) => (
            <button
              key={album.album_id}
              type="button"
              className={`kit-popover-item ${styles.albumMenuItem}`}
              role="menuitem"
              onClick={() => onPick(album)}
            >
              {album.title ?? "Album"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
