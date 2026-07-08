export interface AskButtonProps {
  /** Button label (default "Ask"). */
  label?: string;
  /** Click handler — opens the Ask panel. */
  onClick?: () => void;
}

/** The sparkle "Ask" trigger that opens the vault projection panel. */
export function AskButton({ label = 'Ask', onClick }: AskButtonProps) {
  return (
    <button type="button" className="kit-ask-btn" onClick={onClick}>
      <span className="kit-spark">✦</span> {label}
    </button>
  );
}
