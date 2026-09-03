import { useState } from "react";

import { fmtBytes } from "@centraid/design/elements";

import { canWriteScope, mountedScopes } from "../../_shared/scope-kit.ts";
import { assetBytes } from "../format.ts";
import { runEmptyTrash } from "../trash-actions.ts";
import type { Asset } from "../types.ts";
import { EMPTY_TRASH_COPY, TRASH_NOTE } from "../view-copy.ts";

import styles from "./EmptyTrash.module.css";

export interface EmptyTrashProps {
  trash: readonly Asset[];
  refresh: () => Promise<void>;
}

function blockedLabel(trash: readonly Asset[]): string | null {
  const blocked = trash.find((asset) => !canWriteScope(asset.scope_id));
  if (!blocked) return null;
  const scope = mountedScopes().find(
    (candidate) => candidate.id === (blocked.scope_id ?? "")
  );
  return scope ? scope.label : "that library";
}

export function EmptyTrash({ trash, refresh }: EmptyTrashProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = trash.length;
  const blocked = blockedLabel(trash);
  let bytes = 0;
  for (const asset of trash) bytes += assetBytes(asset) ?? 0;
  const handleOpen = (): void => setConfirming(true);
  const handleCancel = (): void => setConfirming(false);
  const handleConfirm = (): void => {
    setConfirming(false);
    void runEmptyTrash(trash, { refresh, setBusy });
  };
  return (
    <div className={styles.head}>
      <p className={styles.note}>{TRASH_NOTE}</p>
      {count === 0 ? null : confirming ? (
        <fieldset className={styles.confirm}>
          <p className={styles.question}>{EMPTY_TRASH_COPY.question(count)}</p>
          <p className={styles.detail}>
            {EMPTY_TRASH_COPY.detail(count, fmtBytes(bytes, "space they hold"))}
          </p>
          <div className={styles.row}>
            <button
              type="button"
              className={`kit-btn ${styles.destructive}`}
              onClick={handleConfirm}
            >
              {EMPTY_TRASH_COPY.confirm(count)}
            </button>
            <button type="button" className="kit-btn" onClick={handleCancel}>
              {EMPTY_TRASH_COPY.cancel}
            </button>
          </div>
        </fieldset>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={`kit-btn ${styles.destructive}`}
            disabled={busy || blocked !== null}
            onClick={handleOpen}
          >
            {EMPTY_TRASH_COPY.control}
          </button>
          {blocked === null ? null : (
            <p className={styles.reason}>
              {EMPTY_TRASH_COPY.readOnly(blocked)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
