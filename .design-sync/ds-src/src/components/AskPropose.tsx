export interface AskProposeProps {
  /** The proposed change, one line. */
  title: string;
  /** Optional supporting detail. */
  detail?: string;
  /** Optional before → after values. */
  diff?: [before: string, after: string];
  /** Approve handler. */
  onApprove?: () => void;
  /** Edit handler — when set, renders an Edit button. */
  onEdit?: () => void;
  /** Discard handler. */
  onDiscard?: () => void;
}

/**
 * A consent-gated "proposed write" card — the assistant's write, held for the
 * owner's approval before it touches the vault.
 */
export function AskPropose({ title, detail, diff, onApprove, onEdit, onDiscard }: AskProposeProps) {
  return (
    <div className="kit-ask-action">
      <span className="aa-label">Proposed write · needs your ok</span>
      <div className="aa-title">{title}</div>
      {detail ? <div className="aa-detail">{detail}</div> : null}
      {diff ? (
        <div className="kit-aa-diff">
          <span className="d1">{diff[0]}</span> → <span className="d2">{diff[1]}</span>
        </div>
      ) : null}
      <div className="aa-btns">
        <button type="button" className="kit-aa-approve" onClick={onApprove}>
          Approve
        </button>
        {onEdit ? (
          <button type="button" className="kit-aa-ghost aa-edit" onClick={onEdit}>
            Edit
          </button>
        ) : null}
        <button type="button" className="kit-aa-ghost aa-discard" onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
