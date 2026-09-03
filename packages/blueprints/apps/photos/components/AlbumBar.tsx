import { armConfirm } from "@centraid/design/elements";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { usePhotoShare } from "../grant-audiences.ts";
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
  reason?: string;
  onBack: () => void;
  onStartRename: () => void;
  onRenameSubmit: (title: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}) {
  const startRename = canWrite ? onStartRename : () => {};
  const deleteAlbum = canWrite ? onDelete : () => {};
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
