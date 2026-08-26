import { armConfirm } from "@centraid/design/elements";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { usePhotoShare } from "../grant-audiences.ts";
// Destructive is outlined `--net`, never a fill (§18), and arms first.
import { ChevronLeftIcon } from "../icons.tsx";
import { notice } from "../outcomes.ts";
import { InlineInput } from "./InlineInput.tsx";

import styles from "./AlbumBar.module.css";

export function AlbumBar({
  albumId,
  title,
  renaming,
  canWrite,
  reason,
  onBack,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onDelete,
}: {
  albumId: string;
  title: string;
  renaming: boolean;
  canWrite: boolean;
  /** Inline `--net` reason when writes are refused — never a tooltip (§6, §14). */
  reason?: string;
  onBack: () => void;
  onStartRename: () => void;
  onRenameSubmit: (title: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}) {
  // Disabled control's handler is inert too (synthetic activation).
  const startRename = canWrite ? onStartRename : () => {};
  const deleteAlbum = canWrite ? onDelete : () => {};
  // Sharing is not a write to the album — the grant door refuses, not this bar.
  const share = usePhotoShare(notice);
  return (
    <div className={styles.bar}>
      <GrantSheet
        open={share.open}
        onClose={() => share.close()}
        audiences={share.audiences}
        subject={{
          subjectType: "core.collection",
          subjectId: albumId,
          ...(title.trim() ? { label: title.trim() } : {}),
        }}
        onStatus={notice}
      />
      <button
        type="button"
        className={`kit-btn quiet ${styles.back}`}
        onClick={onBack}
      >
        <ChevronLeftIcon size={15} />
        Albums
      </button>

      {renaming ? (
        <InlineInput
          className="kit-input bare"
          value={title}
          placeholder="Album name"
          label="Rename album"
          autoSelect
          onSubmit={onRenameSubmit}
          onCancel={onRenameCancel}
        />
      ) : (
        <div className={styles.actions}>
          <button
            type="button"
            className="kit-btn"
            onClick={() => share.request()}
          >
            Share
          </button>
          <button
            type="button"
            className="kit-btn"
            disabled={!canWrite}
            onClick={startRename}
          >
            Rename
          </button>
          <button
            type="button"
            className={`kit-btn ${styles.destructive}`}
            disabled={!canWrite}
            onClick={(e) => {
              if (!armConfirm(e.currentTarget, { armedLabel: "Delete album?" }))
                return;
              deleteAlbum();
            }}
          >
            Delete album
          </button>
        </div>
      )}

      {/* Refusal inline — writable albums carry no empty line. */}
      {canWrite || reason === undefined ? null : (
        <p className={styles.reason}>{reason}</p>
      )}
    </div>
  );
}
