import {
  useCallback,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import styles from './AssistantScreen.module.css';
import { clearSlash, insertRef, mentionTokenAt, slashCommandAt } from './composerMentions.js';

/** An entity the @-mention picker can offer (a trimmed vault search hit). */
export interface ComposerEntity {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
}

/** A slash command surfaced by the leading `/` menu. */
export interface SlashCommand {
  id: string;
  label: string;
  hint?: string;
  /** When false, the command is shown greyed and not runnable. */
  enabled?: boolean;
}

export interface ComposerAutocompleteOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Persist composer text (the parent's `changeDraft`). */
  setValue: (v: string) => void;
  /** Server entity search for @-mentions (auth-aware `searchVaultEntities`). */
  searchEntities: (term: string) => Promise<ComposerEntity[]>;
  slashCommands: SlashCommand[];
  onRunSlash: (id: string) => void;
}

type Suggest =
  | { kind: 'mention'; start: number; caret: number; items: ComposerEntity[]; loading: boolean }
  | { kind: 'slash'; caret: number; items: SlashCommand[] }
  | null;

/**
 * Composer autocomplete (issue #420): @-mentions (entity picker → inserts a
 * `@[label](ref:type/id)` chip) and slash-commands (leading `/` → runs an
 * existing shell action). Returns an augmented `onChange`, a keydown handler
 * that reports whether it consumed the event (so the composer skips Enter=send
 * while a menu is open), and the popover element to render inside the composer.
 */
export function useComposerAutocomplete(opts: ComposerAutocompleteOptions): {
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  popover: JSX.Element | null;
  close: () => void;
} {
  const [suggest, setSuggest] = useState<Suggest>(null);
  const [active, setActive] = useState(0);
  const searchSeq = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const close = useCallback(() => {
    setSuggest(null);
    setActive(0);
    searchSeq.current += 1;
  }, []);

  const runMentionSearch = useCallback(
    (start: number, caret: number, query: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const seq = ++searchSeq.current;
      setSuggest({ kind: 'mention', start, caret, items: [], loading: true });
      debounceRef.current = setTimeout(() => {
        void opts
          .searchEntities(query)
          .then((items) => {
            if (seq !== searchSeq.current) return;
            setSuggest({ kind: 'mention', start, caret, items, loading: false });
            setActive(0);
          })
          .catch(() => {
            if (seq !== searchSeq.current) return;
            setSuggest({ kind: 'mention', start, caret, items: [], loading: false });
          });
      }, 150);
    },
    [opts],
  );

  const onChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      const caret = e.target.selectionStart ?? value.length;
      opts.setValue(value);

      const mention = mentionTokenAt(value, caret);
      if (mention && mention.query.length >= 1) {
        runMentionSearch(mention.start, caret, mention.query);
        return;
      }
      const slash = slashCommandAt(value, caret);
      if (slash) {
        const q = slash.query.toLowerCase();
        const items = opts.slashCommands.filter(
          (c) => !q || c.id.includes(q) || c.label.toLowerCase().includes(q),
        );
        if (items.length > 0) {
          setSuggest({ kind: 'slash', caret, items });
          setActive(0);
          return;
        }
      }
      close();
    },
    [opts, runMentionSearch, close],
  );

  const setCaret = useCallback(
    (caret: number) => {
      requestAnimationFrame(() => {
        const ta = opts.textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(caret, caret);
      });
    },
    [opts.textareaRef],
  );

  const pick = useCallback(
    (index: number) => {
      if (!suggest) return;
      const value = opts.textareaRef.current?.value ?? '';
      if (suggest.kind === 'mention') {
        const item = suggest.items[index];
        if (!item) return;
        const label = item.title || `${item.type} ${item.id}`;
        const out = insertRef(value, suggest.start, suggest.caret, {
          label,
          type: item.type,
          id: item.id,
        });
        opts.setValue(out.text);
        close();
        setCaret(out.caret);
      } else {
        const cmd = suggest.items[index];
        if (!cmd || cmd.enabled === false) return;
        const next = clearSlash(value, suggest.caret);
        opts.setValue(next);
        close();
        opts.onRunSlash(cmd.id);
      }
    },
    [suggest, opts, close, setCaret],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!suggest) return false;
      const len = suggest.items.length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (len === 0 ? 0 : Math.min(len - 1, a + 1)));
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // Nothing to pick — let the composer handle Enter (send) normally.
        if (len === 0) return false;
        e.preventDefault();
        pick(active);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [suggest, active, pick, close],
  );

  let popover: JSX.Element | null = null;
  if (suggest) {
    const clampedActive = active >= suggest.items.length ? 0 : active;
    popover = (
      <div className={styles.acPopover} role="listbox" aria-label="Composer suggestions">
        {suggest.kind === 'mention' && suggest.loading && suggest.items.length === 0 ? (
          <div className={styles.acEmpty}>Searching…</div>
        ) : suggest.items.length === 0 ? (
          <div className={styles.acEmpty}>
            {suggest.kind === 'mention' ? 'No matches' : 'No commands'}
          </div>
        ) : suggest.kind === 'mention' ? (
          suggest.items.map((item, i) => (
            <button
              key={`${item.type}/${item.id}`}
              type="button"
              role="option"
              aria-selected={i === clampedActive}
              className={styles.acItem}
              data-active={i === clampedActive ? 'true' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className={styles.acItemTitle}>{item.title || `${item.type} ${item.id}`}</span>
              <span className={styles.acItemHint}>{item.subtitle || item.type}</span>
            </button>
          ))
        ) : (
          suggest.items.map((cmd, i) => (
            <button
              key={cmd.id}
              type="button"
              role="option"
              aria-selected={i === clampedActive}
              className={styles.acItem}
              data-active={i === clampedActive ? 'true' : undefined}
              data-disabled={cmd.enabled === false ? 'true' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className={styles.acItemTitle}>/{cmd.label}</span>
              {cmd.hint ? <span className={styles.acItemHint}>{cmd.hint}</span> : null}
            </button>
          ))
        )}
      </div>
    );
  }

  return { onChange, onKeyDown, popover, close };
}
