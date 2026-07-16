import type { JSX, ReactNode } from 'react';
import type { AgentCardDTO, AgentModelDTO } from '../screen-contracts.js';
import styles from './SettingsProvidersScreen.module.css';
import selectCss from '../styles/select.module.css';
import { cx } from '../ui/cx.js';

// The select primitives shared by Settings → Agents' two sections: the routing
// lanes pick an agent and a model, the inventory picks each agent's default
// model, and all three are the same control.

const TIER_ORDER = ['smart', 'balanced', 'fast'] as const;
const TIER_LABEL: Record<(typeof TIER_ORDER)[number], string> = {
  smart: 'Most capable',
  balanced: 'Balanced',
  fast: 'Fastest',
};

export function Select({
  value,
  onChange,
  disabled,
  inherited,
  ariaLabel,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** Mutes the control — this lane reads its value from the default lane. */
  inherited?: boolean;
  ariaLabel: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className={selectCss.selectWrap} data-disabled={disabled ? 'true' : ''}>
      <select
        className={cx(selectCss.select, styles.selectInherited)}
        aria-label={ariaLabel}
        data-inherited={inherited ? 'true' : ''}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </span>
  );
}

function modelOptions(card: AgentCardDTO): JSX.Element[] {
  const opt = (m: AgentModelDTO): JSX.Element => (
    <option key={m.id} value={m.id}>
      {(m.name ?? m.id) + (m.default ? ' · default' : '')}
    </option>
  );
  const tiered = card.models.some((m) => m.tier);
  if (!tiered) return card.models.map(opt);
  const out: JSX.Element[] = [];
  for (const tier of TIER_ORDER) {
    const inTier = card.models.filter((m) => m.tier === tier);
    if (inTier.length) {
      out.push(
        <optgroup key={tier} label={TIER_LABEL[tier]}>
          {inTier.map(opt)}
        </optgroup>,
      );
    }
  }
  const untiered = card.models.filter((m) => !m.tier);
  if (untiered.length) {
    out.push(
      <optgroup key="other" label="Other">
        {untiered.map(opt)}
      </optgroup>,
    );
  }
  return out;
}

/** Human label for a model id, for use inside an inherited-option label. */
export function modelLabel(card: AgentCardDTO | undefined, id: string): string {
  if (!id) return 'agent default';
  const m = card?.models.find((x) => x.id === id);
  return m?.name ?? id;
}

export function ModelSelect({
  card,
  saved,
  onChange,
  emptyLabel,
  ariaLabel,
}: {
  card: AgentCardDTO;
  saved: string;
  onChange: (v: string) => void;
  emptyLabel: string;
  ariaLabel: string;
}): JSX.Element {
  return (
    <Select
      value={saved}
      onChange={onChange}
      disabled={!card.connected}
      inherited={!saved}
      ariaLabel={ariaLabel}
    >
      <option value="">{emptyLabel}</option>
      {saved && !card.models.some((m) => m.id === saved) ? (
        <option value={saved}>{`${saved} · unavailable`}</option>
      ) : null}
      {modelOptions(card)}
      {card.modelsLoading ? (
        <option value="__loading" disabled>
          Discovering models…
        </option>
      ) : null}
    </Select>
  );
}
