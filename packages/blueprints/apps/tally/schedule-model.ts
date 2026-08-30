import { DAY_MS } from "../_shared/format-kit.ts";
// A SCHEDULE IS A SENTENCE, and where it cannot be there is no preview at all
// (Tally spec §3, §6).
//
// The sentence itself is not this app's to write: `@centraid/core/time`'s
// `describeRecurrence` is the ONE member-facing recurrence summary in the
// product (docs/cron-timezone.md), and `queries/dashboard.ts` already calls it
// through `ctx.time` and hands the result over as `preview`. A blueprint app
// cannot reach the time core directly — it lives behind the worker's `ctx` —
// so this module's job is the half that remains: deciding when there IS no
// sentence, and refusing to print a rule in its place.
//
// A RULE NEVER REACHES A SURFACE. `RRULE:FREQ=WEEKLY;BYDAY=TU,TH` on screen is
// not a preview, it is a leak of the storage format, and a member cannot check
// it. So `scheduleSentence` returns `null` and the row says the §6 line
// instead — no preview, and it says why.
//
// DUE NEXT IS THE ONE WRITE WITH NO OPTIMISTIC COPY. Materialising an
// occurrence is excluded from the pending projection by construction
// (`pending-projection.ts`: the occurrence id is minted by the canonical
// recurrence engine), which is exactly why Tally's offline notice names it and
// why Due next repeats the fact where the member is standing.
import type { RecurringTemplate, WeightedSplit } from "./types.ts";

/**
 * The schedule as a sentence, or `null` when the summariser could not phrase
 * this rule. Empty and whitespace count as absent: a preview that renders as
 * nothing is the same lie as a missing one, drawn more expensively.
 */
export function scheduleSentence(
  template: Pick<RecurringTemplate, "preview">
): string | null {
  const preview = template.preview;
  if (typeof preview !== "string") return null;
  const trimmed = preview.trim();
  return trimmed === "" ? null : trimmed;
}

/** The status word a row wears, or the empty string for the ordinary case. A
 *  chip that said ACTIVE on every active row would be a chip about nothing. */
export function statusChip(template: RecurringTemplate): string {
  if (template.status === "paused") return "Paused";
  return template.status === "ended" ? "Ended" : "";
}

/** The weighted splits the vault stores as JSON on the template. A row whose
 *  splits cannot be read carries NONE, and the acts that would rewrite the
 *  template are withheld rather than sent without them. */
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

/**
 * Everything `save-recurring-expense` requires, taken off the template the
 * dashboard returned. `null` means a field the row does not carry — and then
 * the row's Pause, Resume and edit verbs are withheld, because a save that
 * dropped a required field would be refused at the far end of a press.
 */
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

/** Days between two ISO stamps, on the day keys themselves — the same UTC
 *  arithmetic `activity-model.ts` does, and for the same reason: a
 *  local-midnight round trip moves a row a day for members east of London. */
export function daysUntil(iso: string, nowIso: string): number | null {
  const then = Date.parse(`${iso.slice(0, 10)}T00:00:00.000Z`);
  const now = Date.parse(`${nowIso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(then) || Number.isNaN(now)) return null;
  return Math.round((then - now) / DAY_MS);
}

/** When an occurrence falls, in words. `null` where the date cannot be read —
 *  and then the row says nothing about when rather than guessing. */
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
  /** The occurrence's own start, as the materialise write names it. */
  originalStart: string;
  when: string | null;
}

/**
 * What will materialise next, soonest first. A paused or ended template has no
 * next occurrence by definition, and one whose rule could not be expanded
 * carries no `next_start` — both simply do not appear, rather than appearing
 * with an empty date.
 */
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
