import { relativeTime } from "../../../app-format.js";
import type {
  OutboxGrant,
  OutboxItem,
  OutboxNeedsAuth,
  OutboxScopeRequest,
  ReviewEntry,
} from "../../../gateway-client-outbox.js";
import type { VaultParkedEntry } from "../../../gateway-client-vault.js";
import type {
  ApprovalsGrantRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
  ApprovalsActivityRowDTO,
} from "../../screens/ApprovalsScreen.js";

// ── What the frame says about this page (issue #765) ──────────────────────
// The count line under the title, the state that decides which verbs the bar
// offers, and the one persistent status sentence. They live here, beside the
// DTO builders, because all three are derived from the same fetch the builders
// map — a screen that computed them separately could disagree with the bar it
// is rendering under.

/** What the page has to say about, counted. */
export interface ApprovalsTally {
  /** Decisions plus the notices that are a demand rather than news. */
  waiting: number;
  /** Standing grants still in force. */
  grants: number;
}

/**
 * Above this many waiting items the queue stops being scannable and earns its
 * filter chips. It is the `full` state — not a different page, just the same
 * one admitting it is long.
 */
export const APPROVALS_FULL_AT = 4;

export function approvalsState(
  tally: ApprovalsTally
): "ready" | "full" | "empty" {
  if (tally.waiting === 0) return "empty";
  return tally.waiting > APPROVALS_FULL_AT ? "full" : "ready";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The app bar's count line. Empty says what is still true, not what is
 *  missing — there is no zero here, only "nothing waiting". */
export function approvalsCountLine(tally: ApprovalsTally): string {
  const standing = plural(tally.grants, "standing grant", "standing grants");
  if (tally.waiting === 0) return `Nothing waiting · ${standing}`;
  return `${plural(tally.waiting, "decision waiting", "decisions waiting")} · ${standing}`;
}

/**
 * The status line in ready/full. No inline action: every verb this page offers
 * is attached to the thing it acts on, and a status line that offered a
 * shortcut past that would be offering to decide for you.
 */
export function approvalsHealth(tally: ApprovalsTally): {
  label: string;
  detail: string;
} {
  return {
    detail: "Nothing here has happened yet. Approving is the act.",
    label: `${tally.waiting} waiting on you`,
  };
}

/** Titlecase a snake/dot-separated key for the detail panel's field labels. */
function labelFor(key: string): string {
  return key.replace(/[_.]/gu, " ").replace(/\b\w/gu, (c) => c.toUpperCase());
}

/** Render one artifact value readably — arrays join, objects pretty-print. */
function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * `artifact.to` is a recipient address, or a list of them (the gmail-send
 * template's real shape is an array; its own test fixture uses a bare
 * string) — join defensively rather than assume one or the other.
 */
function recipientFrom(
  artifact: Record<string, unknown>,
  fallbackTarget: string
): string {
  const to = artifact.to;
  if (typeof to === "string" && to.length > 0) return to;
  if (Array.isArray(to) && to.length > 0) return to.map(String).join(", ");
  return fallbackTarget;
}

/** Map one wire `OutboxItem` to the screen's row DTO. */
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
    purpose: row.purpose,
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

/**
 * Humanize a review-feed verb for the activity row label (issue #552).
 * Locker reveal/fill copy is special-cased; everything else strips the
 * `act ` prefix and sentence-cases separators so unmapped verbs still read
 * as English (`act sync.remove_connection` → `Sync remove connection`).
 */
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

/** Truncate a long object id for the compact detail line. */
export function truncateObjectId(id: string, max = 12): string {
  if (id.length <= max) return id;
  return `${id.slice(0, Math.max(4, max - 1))}…`;
}

/**
 * Compact detail for an activity row: fill origin, or
 * `objectType · truncatedObjectId` when an id is present, else objectType.
 */
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

/** Map one wire `ReviewEntry` to the screen's activity row DTO (issue #552). */
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

/**
 * Collapse adjacent consecutive activity rows that share verb + object +
 * decision into one row with a `×N` marker (issue #552). Non-adjacent
 * repeats do not collapse. Pure adjacency — no time window.
 */
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
