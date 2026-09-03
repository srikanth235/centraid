import { DAY_MS } from "../_shared/format-kit.ts";
import type { RecurringTemplate, WeightedSplit } from "./types.ts";

export function scheduleSentence(
  template: Pick<RecurringTemplate, "preview">
): string | null {
  const preview = template.preview;
  if (typeof preview !== "string") return null;
  const trimmed = preview.trim();
  return trimmed === "" ? null : trimmed;
}

export function statusChip(template: RecurringTemplate): string {
  if (template.status === "paused") return "Paused";
  return template.status === "ended" ? "Ended" : "";
}

export function weightedSplits(template: RecurringTemplate): WeightedSplit[] {
  const raw = template.splits_json;
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: WeightedSplit[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const partyId = row.party_id;
    const weight = row.weight;
    if (typeof partyId !== "string" || partyId === "") continue;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 1)
      continue;
    out.push({ party_id: partyId, weight: Math.round(weight) });
  }
  return out;
}

export function templateSaveBase(
  template: RecurringTemplate
): Record<string, unknown> | null {
  const splits = weightedSplits(template);
  if (
    splits.length === 0 ||
    !template.group_id ||
    !template.description ||
    !template.paid_by ||
    !template.category ||
    !template.rrule ||
    !template.anchor_start ||
    !template.time_zone
  )
    return null;
  return {
    template_id: template.template_id,
    group_id: template.group_id,
    description: template.description,
    original_amount_minor: template.original_amount_minor,
    original_currency: template.original_currency,
    settlement_currency: template.settlement_currency,
    paid_by: template.paid_by,
    category: template.category,
    splits,
    rrule: template.rrule,
    anchor_start: template.anchor_start,
    time_zone: template.time_zone,
    ...(template.rate_scaled ? { rate_scaled: template.rate_scaled } : {}),
    ...(typeof template.rate_scale === "number"
      ? { rate_scale: template.rate_scale }
      : {}),
    ...(template.rate_source ? { rate_source: template.rate_source } : {}),
    ...(template.rate_date ? { rate_date: template.rate_date } : {}),
  };
}

export function daysUntil(iso: string, nowIso: string): number | null {
  const then = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  const now = Date.parse(`${nowIso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  return Math.round((then - now) / DAY_MS);
}

export function dueLabel(iso: string, nowIso: string): string | null {
  const days = daysUntil(iso, nowIso);
  if (days === null) return null;
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  if (days > 1) return `due in ${days} days`;
  const late = -days;
  return `${late} ${late === 1 ? "day" : "days"} past its date`;
}

export interface DueOccurrence {
  templateId: string;
  description: string;
  amountMinor: number;
  currency: string;
  originalStart: string;
  when: string | null;
}

export function dueNext(
  templates: readonly RecurringTemplate[],
  nowIso: string
): DueOccurrence[] {
  return templates
    .filter(
      (template) =>
        template.status === "active" &&
        typeof template.next_start === "string" &&
        template.next_start !== ""
    )
    .map((template) => ({
      templateId: template.template_id,
      description: template.description,
      amountMinor: template.original_amount_minor,
      currency: template.original_currency,
      originalStart: String(template.next_start),
      when: dueLabel(String(template.next_start), nowIso),
    }))
    .sort((a, b) => a.originalStart.localeCompare(b.originalStart));
}
