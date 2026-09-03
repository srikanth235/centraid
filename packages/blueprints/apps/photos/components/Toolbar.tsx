import type { InlineScope } from "../../inline-types.ts";
import type { KindFilter } from "../filters.ts";
import { KIND_LABELS, KINDS, orderedScopes, scopeIsOn } from "../filters.ts";
import { RUNG_LABELS } from "../layout.ts";
import type { Rung } from "../layout.ts";

import styles from "./Toolbar.module.css";

export interface ToolbarProps {
  scopes: readonly InlineScope[];
  vaultsOn: ReadonlySet<string>;
  onToggleVault: (scopeId: string) => void;
  kind: KindFilter;
  onSelectKind: (kind: KindFilter) => void;
  tileSize?: Rung;
  onStepTileSize?: (delta: number) => void;
}

export function toolbarCarriesSomething(props: ToolbarProps): boolean {
  return props.tileSize !== undefined || props.scopes.length > 1;
}

export function ToolbarView(props: ToolbarProps) {
  const { scopes, vaultsOn, onToggleVault, kind, onSelectKind } = props;
  if (!toolbarCarriesSomething(props)) return null;
  const showVaults = scopes.length > 1;
  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Photos filters">
      <label className={styles.field}>
        <span className="kit-sr-only">Kind</span>
        <select
          className={`kit-input ${styles.select}`}
          value={kind}
          onChange={(e) => onSelectKind(e.target.value as KindFilter)}
        >
          {KINDS.map((entry) => (
            <option key={entry} value={entry}>
              {KIND_LABELS[entry]}
            </option>
          ))}
        </select>
      </label>

      {showVaults ? (
        <fieldset className={styles.vaults}>
          <legend className="kit-sr-only">Shown from</legend>
          {/* Own scope first, then the shell's order — the record, not a name. */}
          {orderedScopes(scopes).map((scope) => (
            <button
              key={scope.id}
              type="button"
              className={`kit-chip quiet ${styles.vaultChip}`}
              aria-pressed={scopeIsOn(vaultsOn, scope.id)}
              data-on={scopeIsOn(vaultsOn, scope.id) ? "true" : "false"}
              onClick={() => onToggleVault(scope.id)}
            >
              {scope.label}
            </button>
          ))}
        </fieldset>
      ) : null}

      {props.tileSize === undefined ||
      props.onStepTileSize === undefined ? null : (
        <TileSizeControl
          tileSize={props.tileSize}
          onStep={props.onStepTileSize}
        />
      )}
    </div>
  );
}

function TileSizeControl({
  tileSize,
  onStep,
}: {
  tileSize: Rung;
  onStep: (delta: number) => void;
}) {
  return (
    <fieldset
      className={styles.stepper}
      aria-label={`Tile size ${tileSize + 1} of ${RUNG_LABELS.length}`}
    >
      {RUNG_LABELS.map((label, index) => (
        <button
          key={label}
          type="button"
          className={styles.rung}
          aria-pressed={index === tileSize}
          onClick={() => onStep(index - tileSize)}
        >
          {label}
        </button>
      ))}
    </fieldset>
  );
}
