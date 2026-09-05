import { plural } from "@centraid/blueprints/apps/_shared/format-kit";

import { relativeTime } from "../../../app-format.js";
import { APPROVALS_HEALTH_DETAIL } from "../../../approvals-copy.js";
import type { EnrichConsentRecord } from "../../../enrich-policy.js";
import type {
  OutboxGrant,
  OutboxItem,
  OutboxNeedsAuth,
  OutboxScopeRequest,
  ReviewEntry,
} from "../../../gateway-client-outbox.js";
import type { VaultParkedEntry } from "../../../gateway-client-vault.js";
import type {
  ApprovalsEnrichConsentRowDTO,
  ApprovalsGrantRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
  ApprovalsActivityRowDTO,
} from "../../screens/ApprovalsScreen.js";

// ── What the frame says about this page (issue #765): count line, bar-deciding state, one status sentence. ──
// Kept beside the DTO builders: all three derive from the same fetch, so a
// screen computing them separately could disagree with its own bar.

export interface ApprovalsTally {
  /** Decisions plus demand-not-news notices. */
  waiting: number;
  grants: number;
}

/** Above this many waiting items the queue earns its filter chips (`full`). */
export const APPROVALS_FULL_AT = 4;

export function approvalsState(
  tally: ApprovalsTally
): "ready" | "full" | "empty" {
  if (tally.waiting === 0) return "empty";
  return tally.waiting > APPROVALS_FULL_AT ? "full" : "ready";
}

/** The app bar's count line; empty says "nothing waiting", never a zero. */
export function approvalsCountLine(tally: ApprovalsTally): string {
  const standing = plural(tally.grants, "standing grant", "standing grants");
  if (tally.waiting === 0) return `Nothing waiting · ${standing}`;
  return `${plural(tally.waiting, "decision waiting", "decisions waiting")} · ${standing}`;
}

/** Status line in ready/full — no inline action: every verb attaches to what it acts on. */
export function approvalsHealth(tally: ApprovalsTally): {
  label: string;
  detail: string;
} {
  return {
    detail: APPROVALS_HEALTH_DETAIL,
    label: `${tally.waiting} waiting on you`,
  };
}

function labelFor(key: string): string {
  return key.replace(/[_.]/gu, " ").replace(/\b\w/gu, (c) => c.toUpperCase());
}

function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/** `artifact.to` may be a bare address or a list — join defensively. */
function recipientFrom(
  artifact: Record<string, unknown>,
  fallbackTarget: string
): string {
  const to = artifact.to;
  if (typeof to === "string" && to.length > 0) return to;
  if (Array.isArray(to) && to.length > 0) return to.map(String).join(", ");
  return fallbackTarget;
}

export function buildOutboxRow(item: OutboxItem): ApprovalsOutboxRowDTO {
  const artifact = item.artifact ?? {};
  const subject =
    typeof artifact.subject === "string" ? artifact.subject : null;
  const body = typeof artifact.body === "string" ? artifact.body : null;
  const fields = Object.entries(artifact).map(([key, value]) => ({
    key,
    label: labelFor(key),
    value: fieldValue(value),
  }));
  return {
    itemId: item.itemId,
    connectionLabel: item.connection.label,
    connectionKind: item.connection.kind,
    verb: item.verb,
    target: item.target,
    recipient: recipientFrom(artifact, item.target),
    subject,
    bodyPreview: body
      ? body.length > 160
        ? `${body.slice(0, 160)}…`
        : body
      : null,
    fields,
    stagedAgo: relativeTime(item.stagedAt),
    note: item.note,
    canEdit: item.canEdit,
    artifact,
    caller: item.actor ?? item.actorKind,
    callerKind: item.actorKind,
  };
}

export function buildNeedsAuthRow(
  row: OutboxNeedsAuth
): ApprovalsNeedsAuthRowDTO {
  return {
    connectionId: row.connectionId,
    label: row.label,
    kind: row.kind,
    note: row.note,
  };
}

export function buildParkedRow(row: VaultParkedEntry): ApprovalsParkedRowDTO {
  return {
    invocationId: row.invocationId,
    command: row.command,
    caller: row.caller ?? row.callerKind,
    callerKind: row.callerKind,
    parkedAgo: relativeTime(row.parkedAt),
    inputPreview: JSON.stringify(row.input, null, 2),
  };
}

function scopeSummary(scopes: OutboxScopeRequest["scopes"]): string {
  return scopes
    .map((s) => {
      const extent = [
        s.rowFilter ? `${s.rowFilter.length} row rule` : "",
        s.fieldMask ? `${s.fieldMask.length} fields` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return `${s.schema}${s.table ? `.${s.table}` : ""} (${s.verbs}${
        extent ? ` · ${extent}` : ""
      })`;
    })
    .join(", ");
}

export function buildScopeRequestRow(
  row: OutboxScopeRequest
): ApprovalsScopeRequestRowDTO {
  return {
    requestId: row.requestId,
    appId: row.appId,
    scopeSummary: scopeSummary(row.scopes),
    requestedAgo: relativeTime(row.requestedAt),
  };
}

export function buildGrantRow(row: OutboxGrant): ApprovalsGrantRowDTO {
  return {
    grantId: row.grantId,
    actorLabel: row.actor ?? row.actorId,
    verb: row.verb,
    target: row.target,
    createdAgo: relativeTime(row.createdAt),
  };
}

/** Humanize a review-feed verb (#552): locker reveal/fill special-cased; others strip `act ` and sentence-case. */
export function humanizeActivityLabel(
  action: string,
  decision: string,
  objectType: string,
  context: ReviewEntry["context"]
): string {
  const isLockerReveal = action === "reveal" && objectType === "locker.item";
  const fillContext = context?.kind === "fill" ? context : undefined;
  const isFill = isLockerReveal && fillContext !== undefined;
  if (isFill) {
    return decision === "allow"
      ? "Locker filled a login"
      : "Locker fill denied";
  }
  if (isLockerReveal) {
    return decision === "allow"
      ? "Locker login revealed"
      : "Locker reveal denied";
  }
  const bare = action.startsWith("act ") ? action.slice(4) : action;
  const spaced = bare.replace(/[._]+/gu, " ").trim();
  if (spaced.length === 0) return action;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function truncateObjectId(id: string, max = 12): string {
  if (id.length <= max) return id;
  return `${id.slice(0, Math.max(4, max - 1))}…`;
}

/** Activity-row detail: fill origin, or `objectType · truncatedObjectId`, else objectType. */
export function formatActivityDetail(
  objectType: string,
  objectId: string | null,
  context: ReviewEntry["context"],
  action: string
): string {
  const isLockerReveal = action === "reveal" && objectType === "locker.item";
  const fillContext = context?.kind === "fill" ? context : undefined;
  if (isLockerReveal && fillContext) return fillContext.origin;
  if (objectId) return `${objectType} · ${truncateObjectId(objectId)}`;
  return objectType;
}

/** Map one wire `ReviewEntry` to the screen's activity row DTO (#552). */
export function buildActivityRow(row: ReviewEntry): ApprovalsActivityRowDTO {
  const label = humanizeActivityLabel(
    row.action,
    row.decision,
    row.objectType,
    row.context
  );
  const detail = formatActivityDetail(
    row.objectType,
    row.objectId,
    row.context,
    row.action
  );
  const attribution: ApprovalsActivityRowDTO["attribution"] =
    row.grantId != null && row.grantId.length > 0
      ? "grant"
      : row.decision === "allow"
        ? "owner"
        : null;
  return {
    receiptId: row.receiptId,
    label,
    detail,
    objectId: row.objectId,
    objectType: row.objectType,
    occurredAgo: relativeTime(row.occurredAt),
    occurredAt: row.occurredAt,
    decision: row.decision,
    risk: row.risk,
    actor: row.actor ?? row.actorKind,
    actorKind: row.actorKind,
    grantId: row.grantId,
    attribution,
    count: 1,
    action: row.action,
  };
}

/** Collapse ADJACENT activity rows sharing verb + object + decision (#552); pure adjacency, no time window. */
export function collapseAdjacentActivity(
  rows: readonly ApprovalsActivityRowDTO[]
): ApprovalsActivityRowDTO[] {
  if (rows.length === 0) return [];
  const out: ApprovalsActivityRowDTO[] = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.action === row.action &&
      prev.objectType === row.objectType &&
      prev.objectId === row.objectId &&
      prev.decision === row.decision
    ) {
      out[out.length - 1] = { ...prev, count: prev.count + 1 };
    } else {
      out.push({ ...row, count: 1 });
    }
  }
  return out;
}

/*
 * Egress-consent ledger rows (#807). The Privacy page reads stored answers,
 * never re-asks: map an answer to words, nothing else — no revoke verb, no
 * inferred state, declines rendered as plainly as grants (a consent surface
 * that hid refusals records only yeses).
 */

const EGRESS_PHRASE: Record<EnrichConsentRecord["egress"], string> = {
  "on-device": "on this device",
  gateway: "on your gateway",
  provider: "at a third-party provider",
};

/** Capability id as a sentence-cased label, so unknown capabilities still read as English. */
export function enrichCapabilityLabel(capability: string): string {
  const spaced = capability.replace(/[._-]+/gu, " ").trim();
  if (spaced.length === 0) return capability;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function buildEnrichConsentRow(
  record: EnrichConsentRecord
): ApprovalsEnrichConsentRowDTO {
  const answer = record.decision === "granted" ? "Granted" : "Declined";
  const where = EGRESS_PHRASE[record.egress];
  const scope =
    record.scopeRef.length > 0 ? ` · ${record.scopeRef}` : " · this vault";
  return {
    id: `${record.capability}:${record.egress}:${record.scopeRef}`,
    meta: record.egress,
    sub: `${answer} · ${where}${scope} · ${relativeTime(record.decidedAt)}`,
    title: enrichCapabilityLabel(record.capability),
  };
}
