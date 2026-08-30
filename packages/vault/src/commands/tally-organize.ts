// governance: allow-repo-hygiene file-size-limit one Tally fixed-point + recurring-materialization contract whose idempotency must stay reviewable together
// Tally time/currency contract (#630). Rates are fixed-point integers and
// recurring materialization is deterministic and idempotent, so two offline
// devices may enqueue one occurrence without duplicates.

import { describeRecurrence, expandRecurrence } from "@centraid/core/time";

import type { Gateway } from "../gateway/gateway.js";
import type { CommandDefinition, HandlerCtx } from "../gateway/types.js";

interface WeightedSplit {
  party_id: string;
  weight: number;
}

interface TemplateRow {
  template_id: string;
  group_id: string;
  description: string;
  original_amount_minor: number;
  original_currency: string;
  settlement_currency: string;
  paid_by: string;
  category: string;
  splits_json: string;
  rrule: string;
  anchor_start: string;
  time_zone: string;
  rate_scaled: number | null;
  rate_scale: number | null;
  rate_source: string | null;
  rate_date: string | null;
  status: "active" | "paused" | "ended";
}

const STRING = { type: "string", minLength: 1 } as const;
const CURRENCY = { type: "string", pattern: "^[A-Za-z]{3}$" } as const;
const RATE_SCALE = 6;

export function convertCurrencyMinor(
  originalMinor: number,
  rateScaled: number,
  rateScale = RATE_SCALE
): number {
  if (
    !Number.isSafeInteger(originalMinor) ||
    originalMinor <= 0 ||
    !Number.isSafeInteger(rateScaled) ||
    rateScaled <= 0 ||
    !Number.isInteger(rateScale) ||
    rateScale < 0 ||
    rateScale > 12
  )
    throw new Error("invalid fixed-point currency conversion");
  const divisor = 10n ** BigInt(rateScale);
  const rounded =
    (BigInt(originalMinor) * BigInt(rateScaled) + divisor / 2n) / divisor;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result) || result <= 0)
    throw new Error("converted amount is outside the supported range");
  return result;
}

function memberIds(ctx: HandlerCtx, groupId: string): Set<string> {
  const rows = ctx.db
    .prepare(
      `SELECT m.party_id FROM social_circle_member m
        JOIN tally_group g ON g.circle_id = m.circle_id
       WHERE g.group_id = ?`
    )
    .all(groupId) as Array<{ party_id: string }>;
  return new Set(rows.map((row) => row.party_id));
}

function validateTemplate(
  ctx: HandlerCtx,
  input: {
    group_id: string;
    original_amount_minor: number;
    original_currency: string;
    settlement_currency: string;
    paid_by: string;
    splits: WeightedSplit[];
    rate_scaled?: number;
    rate_scale?: number;
    rate_source?: string;
    rate_date?: string;
  }
): void {
  const members = memberIds(ctx, input.group_id);
  if (!members.has(input.paid_by))
    throw new Error("payer is not a member of this group");
  if (input.splits.length === 0) throw new Error("choose at least one split");
  const seen = new Set<string>();
  for (const split of input.splits) {
    if (
      seen.has(split.party_id) ||
      !members.has(split.party_id) ||
      !Number.isSafeInteger(split.weight) ||
      split.weight <= 0
    )
      throw new Error("recurring split weights must be unique group members");
    seen.add(split.party_id);
  }
  const original = input.original_currency.toUpperCase();
  const settlement = input.settlement_currency.toUpperCase();
  if (original !== settlement) {
    if (
      input.rate_scaled === undefined ||
      input.rate_source === undefined ||
      input.rate_date === undefined
    )
      throw new Error(
        "cross-currency expenses need a rate, source, and effective date"
      );
    convertCurrencyMinor(
      input.original_amount_minor,
      input.rate_scaled,
      input.rate_scale ?? RATE_SCALE
    );
  }
}

function templateById(ctx: HandlerCtx, templateId: string): TemplateRow {
  const row = ctx.db
    .prepare("SELECT * FROM tally_recurring_expense WHERE template_id = ?")
    .get(templateId) as TemplateRow | undefined;
  if (!row) throw new Error("recurring expense not found");
  return row;
}

const SPLITS = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    required: ["party_id", "weight"],
    additionalProperties: false,
    properties: {
      party_id: STRING,
      weight: { type: "integer", minimum: 1 },
    },
  },
} as const;

const SAVE_RECURRING: CommandDefinition = {
  name: "tally.save_recurring_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: [
      "group_id",
      "description",
      "original_amount_minor",
      "original_currency",
      "settlement_currency",
      "paid_by",
      "category",
      "splits",
      "rrule",
      "anchor_start",
      "time_zone",
    ],
    additionalProperties: false,
    properties: {
      template_id: STRING,
      group_id: STRING,
      description: STRING,
      original_amount_minor: { type: "integer", minimum: 1 },
      original_currency: CURRENCY,
      settlement_currency: CURRENCY,
      paid_by: STRING,
      category: STRING,
      splits: SPLITS,
      rrule: STRING,
      anchor_start: STRING,
      time_zone: STRING,
      rate_scaled: { type: "integer", minimum: 1 },
      rate_scale: { type: "integer", minimum: 0, maximum: 12 },
      rate_source: STRING,
      rate_date: STRING,
      status: { type: "string", enum: ["active", "paused", "ended"] },
    },
  },
  outputSchema: {
    type: "object",
    required: ["template_id", "preview"],
    properties: { template_id: STRING, preview: STRING },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      template_id?: string;
      group_id: string;
      description: string;
      original_amount_minor: number;
      original_currency: string;
      settlement_currency: string;
      paid_by: string;
      category: string;
      splits: WeightedSplit[];
      rrule: string;
      anchor_start: string;
      time_zone: string;
      rate_scaled?: number;
      rate_scale?: number;
      rate_source?: string;
      rate_date?: string;
      status?: "active" | "paused" | "ended";
    };
    const preview = describeRecurrence(input.rrule);
    if (!preview) throw new Error("enter a supported recurrence rule");
    validateTemplate(ctx, input);
    const templateId = input.template_id ?? ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO tally_recurring_expense
          (template_id, group_id, description, original_amount_minor,
           original_currency, settlement_currency, paid_by, category,
           splits_json, rrule, anchor_start, time_zone, rate_scaled,
           rate_scale, rate_source, rate_date, status,
           last_materialized_start, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 NULL, ?, ?)
         ON CONFLICT(template_id) DO UPDATE SET
           group_id = excluded.group_id, description = excluded.description,
           original_amount_minor = excluded.original_amount_minor,
           original_currency = excluded.original_currency,
           settlement_currency = excluded.settlement_currency,
           paid_by = excluded.paid_by, category = excluded.category,
           splits_json = excluded.splits_json, rrule = excluded.rrule,
           anchor_start = excluded.anchor_start, time_zone = excluded.time_zone,
           rate_scaled = excluded.rate_scaled, rate_scale = excluded.rate_scale,
           rate_source = excluded.rate_source, rate_date = excluded.rate_date,
           status = excluded.status, updated_at = excluded.updated_at`
      )
      .run(
        templateId,
        input.group_id,
        input.description.trim(),
        input.original_amount_minor,
        input.original_currency.toUpperCase(),
        input.settlement_currency.toUpperCase(),
        input.paid_by,
        input.category,
        JSON.stringify(input.splits),
        input.rrule,
        input.anchor_start,
        input.time_zone,
        input.rate_scaled ?? null,
        input.rate_scale ?? (input.rate_scaled ? RATE_SCALE : null),
        input.rate_source ?? null,
        input.rate_date ?? null,
        input.status ?? "active",
        ctx.now,
        ctx.now
      );
    ctx.wrote("tally.recurring_expense", templateId);
    return { template_id: templateId, preview };
  },
};

function allocatedSplits(total: number, splits: WeightedSplit[]) {
  const ordered = [...splits].sort((a, b) =>
    a.party_id.localeCompare(b.party_id)
  );
  const weightTotal = ordered.reduce((sum, split) => sum + split.weight, 0);
  let assigned = 0;
  return ordered.map((split, index) => {
    const share =
      index === ordered.length - 1
        ? total - assigned
        : Math.floor((total * split.weight) / weightTotal);
    assigned += share;
    return { party_id: split.party_id, share_minor: share };
  });
}

function exceptionFor(
  ctx: HandlerCtx,
  templateId: string,
  originalStart: string
): { action: "skip" | "override"; override: Record<string, unknown> } | null {
  const row = ctx.db
    .prepare(
      `SELECT action, override_json FROM schedule_recurrence_exception
        WHERE target_type = 'tally.recurring_expense' AND target_id = ?
          AND (
            (scope = 'occurrence' AND original_start = ?)
            OR (scope = 'future' AND original_start <= ?)
          )
        ORDER BY CASE scope WHEN 'occurrence' THEN 0 ELSE 1 END,
                 original_start DESC
        LIMIT 1`
    )
    .get(templateId, originalStart, originalStart) as
    | { action: "skip" | "override"; override_json: string | null }
    | undefined;
  return row
    ? {
        action: row.action,
        override: row.override_json
          ? (JSON.parse(row.override_json) as Record<string, unknown>)
          : {},
      }
    : null;
}

const MATERIALIZE: CommandDefinition = {
  name: "tally.materialize_recurring_expense",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["template_id", "original_start"],
    additionalProperties: false,
    properties: { template_id: STRING, original_start: STRING },
  },
  outputSchema: {
    type: "object",
    required: ["status"],
    properties: {
      status: { type: "string", enum: ["materialized", "existing", "skipped"] },
      expense_id: STRING,
    },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      template_id: string;
      original_start: string;
    };
    const template = templateById(ctx, input.template_id);
    if (template.status !== "active")
      throw new Error("recurring expense is not active");
    const occurrence = expandRecurrence({
      rrule: template.rrule,
      start: template.anchor_start,
      rangeFrom: input.original_start,
      rangeTo: new Date(
        Date.parse(input.original_start) + 86_400_000
      ).toISOString(),
      timeZone: template.time_zone,
      maxInstances: 2,
    }).find((item) => item.originalStart === input.original_start);
    if (!occurrence)
      throw new Error("start is not an occurrence in this series");
    const exception = exceptionFor(
      ctx,
      template.template_id,
      input.original_start
    );
    if (exception?.action === "skip") return { status: "skipped" };
    const override = exception?.override ?? {};
    const originalAmount = Number(
      override.original_amount_minor ?? template.original_amount_minor
    );
    const originalCurrency = String(
      override.original_currency ?? template.original_currency
    ).toUpperCase();
    const settlementCurrency = String(
      override.settlement_currency ?? template.settlement_currency
    ).toUpperCase();
    const rateScaled = Number(
      override.rate_scaled ??
        template.rate_scaled ??
        (originalCurrency === settlementCurrency ? 10 ** RATE_SCALE : 0)
    );
    const rateScale = Number(
      override.rate_scale ?? template.rate_scale ?? RATE_SCALE
    );
    const amount = convertCurrencyMinor(originalAmount, rateScaled, rateScale);
    const spentOn = String(override.spent_on ?? occurrence.start.slice(0, 10));
    const existing = ctx.db
      .prepare(
        `SELECT expense_id FROM tally_expense
          WHERE recurring_template_id = ? AND spent_on = ?`
      )
      .get(template.template_id, spentOn) as { expense_id: string } | undefined;
    if (existing)
      return { status: "existing", expense_id: existing.expense_id };
    const expenseId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO tally_expense
          (expense_id, group_id, description, amount_minor, paid_by, spent_on,
           category, created_at, original_amount_minor, original_currency,
           settlement_currency, rate_scaled, rate_scale, rate_source,
           rate_date, recurring_template_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        expenseId,
        template.group_id,
        String(override.description ?? template.description),
        amount,
        template.paid_by,
        spentOn,
        String(override.category ?? template.category),
        ctx.now,
        originalAmount,
        originalCurrency,
        settlementCurrency,
        rateScaled,
        rateScale,
        String(override.rate_source ?? template.rate_source ?? "identity"),
        String(override.rate_date ?? template.rate_date ?? spentOn),
        template.template_id
      );
    // A template names ONE payer: the single-payer row (#883).
    ctx.db
      .prepare(
        `INSERT INTO tally_expense_payer
          (expense_id, party_id, paid_minor) VALUES (?, ?, ?)`
      )
      .run(expenseId, template.paid_by, amount);
    for (const split of allocatedSplits(
      amount,
      JSON.parse(template.splits_json) as WeightedSplit[]
    )) {
      ctx.db
        .prepare(
          `INSERT INTO tally_expense_split
            (expense_id, party_id, share_minor) VALUES (?, ?, ?)`
        )
        .run(expenseId, split.party_id, split.share_minor);
    }
    ctx.db
      .prepare(
        `UPDATE tally_recurring_expense
          SET last_materialized_start = ?, updated_at = ? WHERE template_id = ?`
      )
      .run(input.original_start, ctx.now, template.template_id);
    ctx.wrote("tally.expense", expenseId);
    ctx.wrote("tally.recurring_expense", template.template_id);
    return { status: "materialized", expense_id: expenseId };
  },
};

const EDIT_OCCURRENCE: CommandDefinition = {
  name: "tally.edit_recurring_expense_occurrence",
  ownerSchema: "tally",
  inputSchema: {
    type: "object",
    required: ["template_id", "original_start", "scope", "action"],
    additionalProperties: false,
    properties: {
      template_id: STRING,
      original_start: STRING,
      scope: { type: "string", enum: ["occurrence", "future", "series"] },
      action: { type: "string", enum: ["skip", "override"] },
      override: { type: "object" },
    },
  },
  outputSchema: {
    type: "object",
    required: ["template_id", "scope"],
    properties: { template_id: STRING, scope: STRING },
  },
  preconditions: [],
  postconditions: [],
  idempotency: "idempotent",
  risk: "low",
  handler: (ctx) => {
    const input = ctx.input as {
      template_id: string;
      original_start: string;
      scope: "occurrence" | "future" | "series";
      action: "skip" | "override";
      override?: Record<string, unknown>;
    };
    templateById(ctx, input.template_id);
    if (input.scope === "series") {
      if (input.action === "skip") {
        ctx.db
          .prepare(
            "UPDATE tally_recurring_expense SET status = 'ended', updated_at = ? WHERE template_id = ?"
          )
          .run(ctx.now, input.template_id);
      } else {
        const allowed = new Set([
          "description",
          "original_amount_minor",
          "rate_scaled",
          "rate_scale",
          "rate_source",
          "rate_date",
          "rrule",
        ]);
        const entries = Object.entries(input.override ?? {}).filter(
          (entry): entry is [string, string | number] =>
            allowed.has(entry[0]) &&
            (typeof entry[1] === "string" || typeof entry[1] === "number")
        );
        if (entries.length > 0)
          ctx.db
            .prepare(
              `UPDATE tally_recurring_expense SET
                ${entries.map(([key]) => `${key} = ?`).join(", ")},
                updated_at = ? WHERE template_id = ?`
            )
            .run(
              ...entries.map(([, value]) => value),
              ctx.now,
              input.template_id
            );
      }
    } else {
      const exceptionId = ctx.newId();
      ctx.db
        .prepare(
          `INSERT INTO schedule_recurrence_exception
            (exception_id, target_type, target_id, original_start, scope,
             action, override_json, created_at, updated_at)
           VALUES (?, 'tally.recurring_expense', ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target_type, target_id, original_start, scope)
           DO UPDATE SET action = excluded.action,
             override_json = excluded.override_json,
             updated_at = excluded.updated_at`
        )
        .run(
          exceptionId,
          input.template_id,
          input.original_start,
          input.scope,
          input.action,
          input.action === "override"
            ? JSON.stringify(input.override ?? {})
            : null,
          ctx.now,
          ctx.now
        );
      ctx.wrote("schedule.recurrence_exception", exceptionId);
    }
    ctx.wrote("tally.recurring_expense", input.template_id);
    return { template_id: input.template_id, scope: input.scope };
  },
};

export function registerTallyOrganizeCommands(gateway: Gateway): void {
  gateway.registerCommand(SAVE_RECURRING);
  gateway.registerCommand(MATERIALIZE);
  gateway.registerCommand(EDIT_OCCURRENCE);
}
