// Scope selector (#599); writes go through write-target.ts. Kit.css owns
// selected fill; labels are scope names, never storage names.
import type { InlineScope } from "../inline-types.ts";

import styles from "./ScopeChips.module.css";

/** Not a scope id; selecting sets null. */
const ALL_LABEL = "All";

export interface ScopeChipsProps {
  scopes: readonly InlineScope[];
  ownScopeId: string;
  selectedScopeId: string | null;
  onSelect: (scopeId: string | null) => void;
  label?: string;
}

export function ScopeChips(props: ScopeChipsProps) {
  const { scopes, ownScopeId, selectedScopeId, onSelect } = props;
  const own = scopes.filter((scope) => scope.id === ownScopeId);
  const audiences = scopes.filter((scope) => scope.id !== ownScopeId);
  const ordered = [...own, ...audiences];

  return (
    <div
      className={styles.scopeChips}
      role="toolbar"
      aria-label={props.label ?? "Shown from"}
    >
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
