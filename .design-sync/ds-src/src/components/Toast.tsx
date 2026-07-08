export interface ToastProps {
  /** The message text. */
  text: string;
  /** Optional action button label (e.g. "Undo"). */
  undoLabel?: string;
  /** Called when the action button is pressed. */
  onUndo?: () => void;
  /** Tone dot on the leading edge. */
  tone?: 'accent' | 'danger';
  /** Called when the dismiss (×) button is pressed. */
  onDismiss?: () => void;
}

/**
 * A single outcome toast — the kit's one feedback channel that follows the
 * user. In the app these live in a fixed `.kit-toasts` host; this renders the
 * bare bubble so it sits in flow.
 */
export function Toast({ text, undoLabel, onUndo, tone, onDismiss }: ToastProps) {
  return (
    <div className="kit-toast" {...(tone ? { 'data-tone': tone } : {})}>
      <span>{text}</span>
      {undoLabel ? (
        <button type="button" className="kit-toast-action" onClick={onUndo}>
          {undoLabel}
        </button>
      ) : null}
      <button type="button" className="kit-toast-close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
