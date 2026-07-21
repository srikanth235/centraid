import type { CSSProperties, JSX } from 'react';
import type { AgentCardDTO } from '../screen-contracts.js';
import { ModelSelect } from './SettingsProvidersSelects.js';
import styles from './SettingsProvidersScreen.module.css';

// Settings → Agents' inventory section: what is installed and which routing
// lanes land on it. Carries no routing choice — those all live in the Routing
// table on the screen itself.
//
// Each entry used to carry an expandable "N tools" drawer listing the builtins
// and MCP tools the agent exposed. That listing is retired: Connections is
// where the user reasons about what an agent can reach, and a flat per-agent
// tool dump duplicated it without the consent story. Host tools are still
// enumerated gateway-side — they ground the builder agent — they just aren't a
// settings surface any more.

/**
 * One agent in the inventory. The "used by" chips report which lanes land here,
 * which is what the old "Active" pill meant back when exactly one agent could be
 * active — and strictly more informative now: they answer what breaks if this
 * agent goes away.
 */
export default function AgentEntry({
  card,
  usedBy,
  isDefault,
  saved,
  onSetModel,
}: {
  card: AgentCardDTO;
  usedBy: string[];
  isDefault: boolean;
  saved: string;
  onSetModel: (v: string) => void;
}): JSX.Element {
  return (
    <div className={styles.entry} style={{ '--row-accent': card.accent } as CSSProperties}>
      <div className={styles.row} data-unavail={card.connected ? '' : 'true'}>
        <span
          className={styles.rowDot}
          style={{ background: card.connected ? card.accent : 'var(--ink-4)' }}
        />
        <div className={styles.rowMeta}>
          <div className={styles.rowName}>{card.title}</div>
          <span className={styles.rowSub}>{card.subtitle}</span>
          <div className={styles.usedBy}>
            {isDefault ? (
              <span className={styles.usedByChip} data-default="true">
                Default
              </span>
            ) : null}
            {usedBy.map((s) => (
              <span key={s} className={styles.usedByChip}>
                {s}
              </span>
            ))}
            {!isDefault && usedBy.length === 0 ? (
              <span className={styles.usedByNone}>Unused</span>
            ) : null}
          </div>
        </div>
        <ModelSelect
          card={card}
          saved={saved}
          onChange={onSetModel}
          emptyLabel="Built-in default"
          ariaLabel={`Default model for ${card.title}`}
        />
      </div>
    </div>
  );
}
