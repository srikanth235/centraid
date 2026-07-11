import { relativeTime } from '../../../app-format.js';
import type {
  OutboxGrant,
  OutboxItem,
  OutboxNeedsAuth,
  OutboxScopeRequest,
} from '../../../gateway-client-outbox.js';
import type { VaultParkedEntry } from '../../../gateway-client-vault.js';
import type {
  ApprovalsGrantRowDTO,
  ApprovalsNeedsAuthRowDTO,
  ApprovalsOutboxRowDTO,
  ApprovalsParkedRowDTO,
  ApprovalsScopeRequestRowDTO,
} from '../../screens/ApprovalsScreen.js';

/** Titlecase a snake/dot-separated key for the detail panel's field labels. */
function labelFor(key: string): string {
  return key
    .replace(/[_.]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Render one artifact value readably — arrays join, objects pretty-print. */
function fieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * `artifact.to` is a recipient address, or a list of them (the gmail-send
 * template's real shape is an array; its own test fixture uses a bare
 * string) — join defensively rather than assume one or the other.
 */
function recipientFrom(artifact: Record<string, unknown>, fallbackTarget: string): string {
  const to = artifact.to;
  if (typeof to === 'string' && to.length > 0) return to;
  if (Array.isArray(to) && to.length > 0) return to.map(String).join(', ');
  return fallbackTarget;
}

/** Map one wire `OutboxItem` to the screen's row DTO. */
export function buildOutboxRow(item: OutboxItem): ApprovalsOutboxRowDTO {
  const artifact = item.artifact ?? {};
  const subject = typeof artifact.subject === 'string' ? artifact.subject : null;
  const body = typeof artifact.body === 'string' ? artifact.body : null;
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
    bodyPreview: body ? (body.length > 160 ? `${body.slice(0, 160)}…` : body) : null,
    fields,
    stagedAgo: relativeTime(item.stagedAt),
    note: item.note,
    canEdit: item.canEdit,
    artifact,
  };
}

export function buildNeedsAuthRow(row: OutboxNeedsAuth): ApprovalsNeedsAuthRowDTO {
  return { connectionId: row.connectionId, label: row.label, kind: row.kind, note: row.note };
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

function scopeSummary(scopes: OutboxScopeRequest['scopes']): string {
  return scopes.map((s) => `${s.schema}${s.table ? `.${s.table}` : ''} (${s.verbs})`).join(', ');
}

export function buildScopeRequestRow(row: OutboxScopeRequest): ApprovalsScopeRequestRowDTO {
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
