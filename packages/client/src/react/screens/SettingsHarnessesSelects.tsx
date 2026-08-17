import type { JSX, ReactNode } from "react";

import type { HarnessCardDTO, HarnessModelDTO } from "../screen-contracts.js";
import { cx } from "../ui/cx.js";

import selectCss from "../styles/select.module.css";
import styles from "./SettingsHarnessesScreen.module.css";

// The select primitives shared by Settings → Agents' two sections: the routing
// lanes pick a harness and a model, the inventory picks each harness's default
// model, and all three are the same control.

const TIER_ORDER = ["smart", "balanced", "fast"] as const;
const TIER_LABEL: Record<(typeof TIER_ORDER)[number], string> = {
  smart: "Most capable",
  balanced: "Balanced",
  fast: "Fastest",
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
    <span
      className={cx(selectCss.selectWrap, styles.selectField)}
      data-disabled={disabled ? "true" : ""}
    >
      <select
        className={cx(selectCss.select, styles.selectInherited)}
        aria-label={ariaLabel}
        data-inherited={inherited ? "true" : ""}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </span>
  );
}

function modelOptions(card: HarnessCardDTO): JSX.Element[] {
  const opt = (m: HarnessModelDTO): JSX.Element => (
    <option key={m.id} value={m.id}>
      {(m.name ?? m.id) + (m.default ? " · default" : "")}
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
        </optgroup>
      );
    }
  }
  const untiered = card.models.filter((m) => !m.tier);
  if (untiered.length) {
    out.push(
      <optgroup key="other" label="Other">
        {untiered.map(opt)}
      </optgroup>
    );
  }
  return out;
}

/** Human label for a model id, for use inside an inherited-option label. */
export function modelLabel(
  card: HarnessCardDTO | undefined,
  id: string
): string {
  if (!id) return "agent default";
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
  card: HarnessCardDTO;
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

/**
 * The reasoning levels this harness's live probe offers, in its own vocabulary.
 *
 * REASONING LEVEL IS A PROPERTY OF THE MODEL, and this is as close as the wire
 * gets to saying so: ACP reports one `thought_level` option per SESSION
 * (`packages/server/src/acp/backends/acp/session-config.ts`), refreshed by
 * `config_option_update`, and `HarnessModelDTO` carries no per-model levels at
 * all. So the offered set is read from the probe rather than invented here, and
 * a level outside it is treated as a level the model cannot do.
 */
export function effortValues(card: HarnessCardDTO): string[] {
  const option = card.configOptions?.find(
    (entry) => entry.category === "thought_level"
  );
  return (option?.values ?? []).map((entry) => entry.value);
}

/**
 * A stored level the newly-picked model cannot do is dropped back to inherit —
 * a pin the harness would silently ignore is a control lying about its effect.
 * Returns the value to store, which is `saved` whenever the level still fits.
 */
export function clampEffort(card: HarnessCardDTO, saved: string): string {
  if (!saved) return "";
  return effortValues(card).includes(saved) ? saved : "";
}

/**
 * A pick with nothing to open, stated rather than offered: a model with no
 * thinking budget gets this line, not a disabled select that looks openable.
 */
export function NoThinkingPick(): JSX.Element {
  return <span className={styles.inertPick}>no thinking</span>;
}

export function ConfigSelect({
  card,
  category,
  saved,
  onChange,
  emptyLabel,
  ariaLabel,
}: {
  card: HarnessCardDTO;
  category: string;
  saved: string;
  onChange: (v: string) => void;
  emptyLabel: string;
  ariaLabel: string;
}): JSX.Element | null {
  const option = card.configOptions?.find(
    (entry) => entry.category === category
  );
  if (!option || option.values.length === 0)
    return category === "thought_level" ? <NoThinkingPick /> : null;
  return (
    <Select
      value={saved}
      onChange={onChange}
      disabled={!card.connected}
      inherited={!saved}
      ariaLabel={ariaLabel}
    >
      <option value="">{emptyLabel}</option>
      {saved && !option.values.some((entry) => entry.value === saved) ? (
        <option value={saved}>{`${saved} · unavailable`}</option>
      ) : null}
      {option.values.map((entry) => (
        <option key={entry.value} value={entry.value}>
          {entry.name ?? entry.value}
        </option>
      ))}
    </Select>
  );
}
