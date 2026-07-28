// The scope selector for multi-scope apps (issue #599): `All · <own> ·
// <audiences…>` as a row of kit chips. Presentational and stateless — the
// selection lives in the app, which also decides what "All" means for its own
// projection (see write-target.ts for what it means for writes).
//
// Styling is kit.css's global `.kit-chip` plus a layout-only module: selection
// is expressed with `aria-pressed`, which `.kit-chip[aria-pressed='true']`
// already paints, so no app hard-codes a colour. A scope's optional `color`
// stays out of the chip fill on purpose — it is a per-scope accent the app may
// use elsewhere; overriding the chip here would fork the kit's selected state.
//
// The chip labels are the only scope strings a user ever sees; they never name
// the underlying storage.
import type { InlineScope } from '../inline-types.ts';

import styles from './ScopeChips.module.css';

/** The "everything, merged" chip. Not a scope id — selection is null for it. */
const ALL_LABEL = 'All';

export interface ScopeChipsProps {
  /** Every mounted scope, own scope included, in display order. */
  scopes: readonly InlineScope[];
  /** The id of the member's own scope — rendered first, right after "All". */
  ownScopeId: string;
  /** Selected scope id, or null for "All". */
  selectedScopeId: string | null;
  onSelect: (scopeId: string | null) => void;
  /** Accessible name for the group (defaults to a neutral one). */
  label?: string;
}

export function ScopeChips(props: ScopeChipsProps) {
  const { scopes, ownScopeId, selectedScopeId, onSelect } = props;
  const own = scopes.filter((scope) => scope.id === ownScopeId);
  const audiences = scopes.filter((scope) => scope.id !== ownScopeId);
  const ordered = [...own, ...audiences];

  return (
    // A toolbar of toggle buttons is the ARIA pattern these chips already are
    // (`aria-pressed` on each): one tab stop, arrow keys inside.
    <div className={styles.scopeChips} role="toolbar" aria-label={props.label ?? 'Shown from'}>
      <button
        type="button"
        className="kit-chip"
        aria-pressed={selectedScopeId == null}
        onClick={() => onSelect(null)}
      >
        {ALL_LABEL}
      </button>
      {ordered.map((scope) => (
        <button
          key={scope.id}
          type="button"
          className="kit-chip"
          aria-pressed={selectedScopeId === scope.id}
          onClick={() => onSelect(scope.id)}
        >
          {scope.label}
        </button>
      ))}
    </div>
  );
}
