import type { JSX, ReactNode } from "react";

import type { HarnessCardDTO, HarnessModelDTO } from "../screen-contracts.js";
import { cx } from "../ui/cx.js";

import selectCss from "../styles/select.module.css";
import styles from "./SettingsHarnessesScreen.module.css";

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

export function modelLabel(
  card: HarnessCardDTO | undefined,
  id: string
): string {
  if (id) return card?.models.find((x) => x.id === id)?.name ?? id;
  const fallback = card?.models.find((m) => m.default) ?? card?.models[0];
  if (!fallback) return "agent default";
  return fallback.name ?? fallback.id;
}

export function effortLabel(
  card: HarnessCardDTO | undefined,
  value: string
): string {
  if (!value) return "no thinking";
  const option = card?.configOptions?.find(
    (entry) => entry.category === "thought_level"
  );
  return option?.values.find((entry) => entry.value === value)?.name ?? value;
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

export function effortValues(card: HarnessCardDTO): string[] {
  const option = card.configOptions?.find(
    (entry) => entry.category === "thought_level"
  );
  return (option?.values ?? []).map((entry) => entry.value);
}

export function clampEffort(card: HarnessCardDTO, saved: string): string {
  if (!saved) return "";
  return effortValues(card).includes(saved) ? saved : "";
}

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
