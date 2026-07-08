export interface MeterProps {
  /** Fill ratio, 0–1 (clamped). */
  ratio: number;
  /** Tone of the fill. */
  tone?: 'danger' | 'warn';
}

/** A slim proportion bar / meter — a ratio rendered as a filled track. */
export function Meter({ ratio, tone }: MeterProps) {
  const pct = Math.max(0, Math.min(1, ratio)) * 100;
  return (
    <span className="kit-bar" aria-hidden="true">
      <span
        className="kit-bar-fill"
        style={{ width: `${pct}%` }}
        {...(tone ? { 'data-tone': tone } : {})}
      />
    </span>
  );
}
