// The Photos toolbar row (v4 handoff §3): the kind filter menu, the vault
// filter menu, and the tile-size stepper. That is the whole row.
//
// The title, the count, `Select` and `Import` are GONE from here — they are
// the frame's app bar now (frame.tsx), which is why this row is three controls
// and not a header.
//
// IT RENDERS ONLY WHEN IT CARRIES SOMETHING. An empty band is chrome, so the
// component returns null rather than an empty 44px rule: on the Albums card
// grid there is no tile size to step, and a member with one vault has no vault
// to filter. In selection the row becomes the selection bar, which the app
// renders in its own region — this component is not asked to draw it.
//
// The vault filter reads the RECORD, never a name (filters.ts): the order is
// the member's own scope, then the rest as the shell listed them — while what
// the member READS is `scope.label`, which the shell owns and the owner may
// rename.
import type { InlineScope } from "../../inline-types.ts";
import type { KindFilter } from "../filters.ts";
import { KIND_LABELS, KINDS, orderedScopes, scopeIsOn } from "../filters.ts";
import { RUNG_LABELS } from "../layout.ts";
import type { Rung } from "../layout.ts";

import styles from "./Toolbar.module.css";

export interface ToolbarProps {
  /** Every mounted scope. One entry means "no vault filter at all". */
  scopes: readonly InlineScope[];
  /** Which vaults are in the merged timeline; empty means every one. */
  vaultsOn: ReadonlySet<string>;
  onToggleVault: (scopeId: string) => void;
  kind: KindFilter;
  onSelectKind: (kind: KindFilter) => void;
  /** Absent where tiles are not packed — the row then has one control fewer,
   *  and may have none at all. */
  tileSize?: Rung;
  onStepTileSize?: (delta: number) => void;
}

/** Does this row carry anything? The render rule, as a value, so a caller can
 *  ask before it lays anything out. */
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
          {/* Own scope first, then every other audience, in the shell's own
              order — the record, never a name (§H). */}
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
        <TileSizeStepper
          tileSize={props.tileSize}
          onStep={props.onStepTileSize}
        />
      )}
    </div>
  );
}

/** Four rungs, XS–L (§4.2). Both controls are labelled: an icon-only control
 *  without a name is not a control (§18). */
function TileSizeStepper({
  tileSize,
  onStep,
}: {
  tileSize: Rung;
  onStep: (delta: number) => void;
}) {
  return (
    <fieldset className={styles.stepper}>
      <legend className="kit-sr-only">Tile size</legend>
      <button
        type="button"
        className="kit-icon-btn"
        aria-label="Smaller tiles"
        disabled={tileSize === 0}
        onClick={() => onStep(-1)}
      >
        −
      </button>
      <span className={styles.rung} aria-live="off">
        {RUNG_LABELS[tileSize]}
      </span>
      <button
        type="button"
        className="kit-icon-btn"
        aria-label="Larger tiles"
        disabled={tileSize === RUNG_LABELS.length - 1}
        onClick={() => onStep(1)}
      >
        +
      </button>
    </fieldset>
  );
}
