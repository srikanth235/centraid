import { armConfirm } from "@centraid/design/elements";

import { GrantSheet } from "../../_shared/GrantSheet.tsx";
import { usePhotoShare } from "../grant-audiences.ts";
// Album detail's own row (v4 handoff §5): "Album detail keeps the app bar,
// drops the shelf strip, adds a way back, and carries the album's own title
// and count in the bar."
//
// So this component occupies the shelf strip's slot in album detail: the way
// back, and the album's own two writes — rename and delete. The title and the
// count are NOT here; they are the
// frame's app bar, contributed by frame.tsx.
//
// Destructive is an outlined `--net` button, never a fill (§18), and it arms
// before it fires — the kit's `armConfirm`, the same confirmation every
// destructive action in this app uses on every surface.
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
  /** The album this bar stands over — the `core.collection` a grant names. */
  albumId: string;
  title: string;
  renaming: boolean;
  /** A read-only audience disables the two writes and says why inline — the
   *  control never fires (§6, §14). */
  canWrite: boolean;
  /**
   * WHY the two writes are refused, said INLINE (README:233, proto 4789):
   * "the reason is stated inline under the bar in `--net` mono — never a
   * tooltip, and the control never fires". This prop is what makes the
   * doc-comment above true; without it the bar disabled Rename and Delete and
   * said nothing at all, which is a refusal the member cannot act on.
   * Undefined while the album is writable — there is nothing to explain.
   */
  reason?: string;
  onBack: () => void;
  onStartRename: () => void;
  onRenameSubmit: (title: string) => void;
  onRenameCancel: () => void;
  onDelete: () => void;
}) {
  // Defense in depth, the same rule the selection bar's actions follow: a
  // disabled control's HANDLER is inert too, so nothing that reaches past the
  // DOM attribute (a synthetic activation, a future caller) can fire a write
  // this member is not allowed to make.
  const startRename = canWrite ? onStartRename : () => {};
  const deleteAlbum = canWrite ? onDelete : () => {};
  // SHARING AN ALBUM IS NOT A WRITE TO IT. A member viewing a read-only
  // library still owns nothing here to give, but the grant door — not this
  // bar — is what refuses that, and it refuses with its own sentence. What
  // this bar knows is only which album the sheet is opened over.
  const share = usePhotoShare(notice);
  return (
    <div className={styles.bar}>
      <GrantSheet
        open={share.open}
        onClose={() => share.close()}
        audiences={share.audiences}
        // The album, as the ONE subject: `core.collection`. Membership does
        // the rest — a photograph added to it later reaches the same audience
        // with no second gesture and no re-share call from this app.
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

      {/* The refusal, in the bar itself — one line of `--net` mono under the
          controls it explains. Rendered only when there IS a refusal, so a
          writable album carries no empty line. */}
      {canWrite || reason === undefined ? null : (
        <p className={styles.reason}>{reason}</p>
      )}
    </div>
  );
}
