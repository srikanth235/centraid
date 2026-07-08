export interface AskAppliedProps {
  /** What was applied. */
  title: string;
  /** Receipt line (defaults to "saved as a receipt"). */
  receipt?: string;
  /** When set, renders an Undo button. */
  onUndo?: () => void;
}

/** A receipt card confirming a write the assistant just applied. */
export function AskApplied({ title, receipt = 'saved as a receipt', onUndo }: AskAppliedProps) {
  return (
    <div className="kit-ask-applied">
      <span className="ck">✓</span>
      <span className="ac-t">
        {title}
        <span className="ac-s">{receipt}</span>
      </span>
      {onUndo ? (
        <button type="button" className="ac-undo" onClick={onUndo}>
          Undo
        </button>
      ) : null}
    </div>
  );
}
