import { useRef } from "react";
import type { FC } from "react";

import { armConfirm } from "@centraid/design/elements";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { buildSelectionActions } from "../../_shared/selection-engine.ts";
import type { SelectionShelfKind } from "../../_shared/selection-engine.ts";
import { parseAssetKey } from "../asset-key.ts";
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

export const LABEL_BREAKPOINT = 840;

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
  reason?: string;
  destructive?: boolean;
  confirmLabel?: string;
}

export interface BuildSelectionActionsInput {
  count: number;
  shelfKind: SelectionShelfKind;
  copyLabel: string;
  readOnlyReason: string | null;
  copyBlockedReason: string | null;
  onFavorite: () => void;
  onAddToAlbum: () => void;
  onShare: () => void;
  onDownload: () => void;
  onTrash: () => void;
}

export function buildPhotoSelectionActions({
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
  return buildSelectionActions({
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
  visible: readonly Asset[];
  albums: Album[];
  shelfKind: SelectionShelfKind;
  readOnlyReason: string | null;
  menuOpen: boolean;
  busy: boolean;
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

  // oxlint-disable-next-line react/react-compiler
  const actions = buildPhotoSelectionActions({
    count,
    shelfKind,
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
          onClose={() => share.close()}
          audiences={share.audiences}
          subject={{
            subjectType: "media.asset",
            subjectId: parseAssetKey(only).assetId,
          }}
          onStatus={notice}
        />
      ) : null}
      <span className={styles.count} ref={countRef}>
        {count}
      </span>
      <span className={styles.countLabel}>selected</span>
      <span className={styles.spacer} />
      {/* A real <fieldset>, not role="group". */}
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
  onAddToAlbum: () => void;
}

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
  const actions = buildPhotoSelectionActions({
    count,
    shelfKind,
    copyLabel: "Share",
    readOnlyReason,
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
          onClose={() => share.close()}
          audiences={share.audiences}
          subject={{
            subjectType: "media.asset",
            subjectId: parseAssetKey(only).assetId,
          }}
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
