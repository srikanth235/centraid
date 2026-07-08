import type { ReactNode } from 'react';

export interface AskPanelProps {
  /** The vault scope this panel projects, shown in the context row. */
  scope?: string;
  /** The subtitle beside the title (default "a projection of your vault"). */
  note?: string;
  /** The consent/grant chip text (async-resolved in the app). */
  grantLabel?: string;
  /** Opening assistant message, shown when no children are provided. */
  intro?: string;
  /** Suggested prompts rendered as chips. */
  suggestions?: string[];
  /** Composer placeholder. */
  placeholder?: string;
  /** Conversation content (Message / AskTyping / AskApplied / AskPropose). */
  children?: ReactNode;
}

// The kit's inline mic glyph, verbatim.
function Mic() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

/**
 * The "Ask your vault" panel — the signature conversational surface. This is
 * the static shell (dialog, context row, log, suggestions, composer); wire the
 * button handlers and an SSE driver to make it live.
 */
export function AskPanel({
  scope = 'this app',
  note = 'a projection of your vault',
  grantLabel = 'read + write · consent-gated',
  intro = 'Ask me anything about what this app holds.',
  suggestions = [],
  placeholder = 'Ask your vault…',
  children,
}: AskPanelProps) {
  return (
    <div className="kit-ask-panel" role="dialog" aria-modal="true" aria-label="Ask your vault">
      <div className="kit-ask-head">
        <h2>Ask</h2>
        <span className="kit-ask-note">{note}</span>
        <button type="button" className="kit-ask-x" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="kit-ask-context">
        <span className="kit-ask-scope">Scope · {scope}</span>
        <span className="kit-ask-scope" data-kit-grant>
          {grantLabel}
        </span>
      </div>
      <div className="kit-ask-log" role="log" aria-live="polite">
        {children ?? <div className="kit-msg ai">{intro}</div>}
      </div>
      {suggestions.length ? (
        <div className="kit-ask-suggest">
          {suggestions.map((s, i) => (
            <button key={i} type="button" className="kit-ask-chip">
              {s}
            </button>
          ))}
        </div>
      ) : null}
      <form className="kit-ask-compose">
        <button type="button" className="kit-ask-mic" aria-label="Voice">
          <Mic />
        </button>
        <input placeholder={placeholder} aria-label="Ask" />
        <button className="kit-ask-send" type="submit" aria-label="Send">
          →
        </button>
      </form>
    </div>
  );
}
