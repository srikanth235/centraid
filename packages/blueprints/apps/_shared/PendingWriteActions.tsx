import type { MouseEvent } from "react";

import { formatRelativeTime } from "@centraid/design";

import {
  pendingOverlayCanDiscard,
  pendingOverlayCanRetry,
  pendingChangeLabel,
  pendingOverlayCopy,
  pendingSidecarOf,
  readPendingOverlay,
} from "./pending-overlay.ts";

export function PendingWriteActions({
  row,
  onEdit,
}: {
  row: Readonly<Record<string, unknown>>;
  onEdit?: () => void;
}) {
  const pending = readPendingOverlay(row, pendingSidecarOf(row));
  if (!pending) return null;
  const scopeId =
    typeof row.__centraidScopeId === "string"
      ? row.__centraidScopeId
      : undefined;
  const retryable = pendingOverlayCanRetry(pending);
  const discardable = pendingOverlayCanDiscard(pending);
  // Attempted and still queued is stuck, not merely offline — say since when.
  const stuckSince =
    pending.status === "queued" &&
    (pending.attempts ?? 0) > 0 &&
    pending.enqueuedAt
      ? formatRelativeTime(pending.enqueuedAt)
      : undefined;
  const act =
    (action: () => void | Promise<unknown>) =>
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      void action();
    };

  return (
    <span
      aria-label={pendingChangeLabel(pending)}
      style={{
        alignItems: "center",
        display: "inline-flex",
        flexWrap: "wrap",
        gap: "var(--sp-2, 8px)",
        position: "relative",
        zIndex: 2,
      }}
    >
      <span className="kit-pending-chip" title={pendingOverlayCopy(pending)}>
        {pending.status}
      </span>
      {pending.status === "parked" || retryable ? (
        <small>{pendingOverlayCopy(pending)}</small>
      ) : null}
      {stuckSince ? <small>Queued {stuckSince}</small> : null}
      {pending.status === "parked" ? (
        window.centraid.openApprovals ? (
          <button
            type="button"
            className="kit-btn"
            onClick={act(window.centraid.openApprovals)}
          >
            Review in Approvals
          </button>
        ) : (
          <small>Review in Approvals.</small>
        )
      ) : null}
      {retryable && onEdit ? (
        <button type="button" className="kit-btn" onClick={act(onEdit)}>
          Edit
        </button>
      ) : null}
      {retryable ? (
        <button
          type="button"
          className="kit-btn"
          onClick={act(() =>
            window.centraid.retryPendingWrite?.(pending.key, scopeId)
          )}
        >
          Retry
        </button>
      ) : null}
      {discardable ? (
        <button
          type="button"
          className="kit-btn"
          onClick={act(() =>
            window.centraid.discardPendingWrite?.(pending.key, scopeId)
          )}
        >
          Discard
        </button>
      ) : null}
    </span>
  );
}
