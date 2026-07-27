import type {
  ChangeEvent,
  FocusEventHandler,
  JSX,
  KeyboardEventHandler,
  ReactNode,
  RefObject,
  ClipboardEventHandler,
} from 'react';
import Icon from '../ui/Icon.js';
import SessionStatusStrip from './SessionStatusStrip.js';
import styles from './ChatComposer.module.css';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string, event: ChangeEvent<HTMLTextAreaElement>) => void;
  onSend: () => void;
  onStop?: () => void;
  busy: boolean;
  disabled?: boolean;
  canSend?: boolean;
  placeholder: string;
  ariaLabel: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onBlur?: FocusEventHandler<HTMLTextAreaElement>;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  above?: ReactNode;
  leading?: ReactNode;
  model?: ReactNode;
  effort?: ReactNode;
  context?: { used: number; size: number };
  hint?: ReactNode;
  embedded?: boolean;
}

/**
 * Shared conversation composer for Assistant, Builder, and automation Q&A.
 * Surface-specific attachments/autocomplete live in slots; the input,
 * send/stop control, and session telemetry stay one implementation.
 */
export default function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  busy,
  disabled = false,
  canSend = value.trim().length > 0,
  placeholder,
  ariaLabel,
  textareaRef,
  onKeyDown,
  onBlur,
  onPaste,
  above,
  leading,
  model,
  effort,
  context,
  hint,
  embedded = false,
}: ChatComposerProps): JSX.Element {
  const submit = (): void => {
    if (busy) {
      onStop?.();
      return;
    }
    if (!disabled && canSend) onSend();
  };
  return (
    <div className={styles.root} data-embedded={embedded ? 'true' : undefined}>
      {above}
      <textarea
        ref={textareaRef}
        className={styles.input}
        rows={1}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        data-busy={busy ? 'true' : undefined}
        onChange={(event) => onChange(event.target.value, event)}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (event.defaultPrevented) return;
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        onBlur={onBlur}
        onPaste={onPaste}
      />
      <SessionStatusStrip
        busy={busy}
        context={context}
        leading={leading}
        model={model}
        effort={
          <>
            {effort}
            <button
              type="button"
              className={styles.send}
              aria-label={busy ? 'Stop' : 'Send'}
              disabled={!busy && (disabled || !canSend)}
              onClick={submit}
            >
              <Icon name={busy ? 'Stop' : 'Send'} size={14} />
            </button>
          </>
        }
      />
      {hint ? <div className={styles.hint}>{hint}</div> : null}
    </div>
  );
}
