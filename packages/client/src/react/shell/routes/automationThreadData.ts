// Automation thread data layer (Automations UI revamp — see
// receipts/issue-387-automations-ui-revamp.md). The thread is one long-lived conversation per
// automation: every fire is a run appended to it, and consent (parked
// invocations, staged outbox writes, standing grants) surfaces inline
// instead of behind a separate Approvals detour. This module aggregates the
// automation row, its runs, and the GLOBAL consent lists (there is no
// automation-scoped consent endpoint), filters the latter down to this
// automation's actor, and derives the `AutomationThreadData` DTO the thread
// screen renders — reusing `deriveAutomationHero`/`triggerOriginLabel`/
// `AU_STATUS_LABEL` from automationsData.ts rather than re-deriving the
// hero/trigger block a second time.
import { auStatusForRow, glyphForId, hueForId } from '../../../automation-identity.js';
import {
  confirmVaultParked,
  decideOutboxItem,
  getBlocking,
  listAutomationRuns,
  listOutboxGrants,
  readAutomation,
  revokeOutboxGrant,
  type BlockingSummary,
  type OutboxGrant,
} from '../../../gateway-client.js';
import type {
  AuConsentDTO,
  AuStatusKind,
  AutomationThreadData,
  AutomationThreadHeaderDTO,
  ConsentDecision,
  ConsentKind,
  ThreadRunDTO,
  ThreadRunStatus,
} from '../../screen-contracts.js';
import { AU_STATUS_LABEL, deriveAutomationHero, triggerOriginLabel } from './automationsData.js';

/**
 * The result `loadAutomationThreadData` hands back to the route wrapper. The
 * screen-facing `data` is the self-contained `AutomationThreadData` DTO
 * (screen-contracts.ts, no ambient ipc types); `row` rides alongside it —
 * NOT inside `data` — so the route wrapper (which owns edit/delete/rotate
 * navigation, same as `AutomationViewRoute.tsx`'s `rowRef`) keeps the raw
 * `CentraidAutomationRow` without screen-contracts.ts having to import it
 * (that file is deliberately kept free of the renderer's ambient
 * `centraid-api.d.ts` globals — see its file header).
 */
export interface AutomationThreadLoadResult {
  row: CentraidAutomationRow;
  data: AutomationThreadData;
}

// ── Consent actor matching (verified against the gateway/vault source, not
// assumed) ───────────────────────────────────────────────────────────────
//
// Every automation fire rides ONE enrolled agent identity, keyed by the
// automation's OWNING APP FOLDER, not its row id/ref:
//   - `reconcileScheduler` enrolls one agent per `row.ownerApp`
//     (packages/gateway/src/serve/build-gateway.ts:1157-1166:
//     `vaultRegistry.enrollAutomationAgent(appId, nameByOwnerApp.get(appId))`
//     where `appId` iterates `new Set(rows.map((r) => r.ownerApp))`).
//   - `enrollAutomationAgent` calls `ensureAgentEnrolled(db, appId, {
//     displayName })` (packages/gateway/src/serve/vault-plane.ts:520-526),
//     which stores `appId` as `agent_agent.host_key` and `displayName`
//     (== the automation's manifest `name`, same value `row.name` carries)
//     as `core_party.display_name` — self-healing on rename
//     (packages/vault/src/host.ts:415-455).
//
// None of the three consent surfaces expose that `ownerApp`/host_key to the
// renderer, and only two of them expose the enrolled agent's row id at all:
//   - `OutboxItem` (an outbox-staged write) carries only `actor` (the
//     resolved DISPLAY NAME) and `actorKind` — `OutboxItemSummary`
//     (vault-plane.ts:227-242) never puts `actor_id` on the wire.
//   - `OutboxGrant.actorId` and `VaultParkedEntry.callerId` DO carry the raw
//     `agent_agent.agent_id` (vault-plane.ts:934-965 `listOutboxGrants`;
//     packages/vault/src/gateway/gateway.ts:1292-1311 `listParked`), but the
//     renderer has no lookup from a `CentraidAutomationRow` to that id — no
//     `/centraid/_vault/agents` client fn exists in gateway-client-vault.ts
//     even though the route is mounted server-side (vault-routes.ts:18/364).
//
// The only field ALL THREE surfaces carry that the renderer can compare to
// something it already holds is therefore the enrolled agent's DISPLAY
// NAME, which stays in sync with `CentraidAutomationRow.name` (same
// `displayName` source as above). Filtering matches `actor`/`caller` ===
// `row.name`, additionally requiring `actorKind`/`callerKind === 'agent'` so
// a same-named connected app or the vault assistant (`callerKind:
// 'assistant'`) never leaks into an automation's thread.
//
// This is a SOFT match: two automations sharing a display name would
// collide, a very recent rename lags until the next scheduler reconcile
// tick, and `OutboxGrant` carries no `actorKind` at all (grants are matched
// on name alone — a coincidental app/automation name collision could leak a
// grant here). A follow-up that exposes `agent_agent.agent_id` (e.g. a
// renderer `listAgents()` client fn over the existing
// `/centraid/_vault/agents` route) would let this become an exact id match.
// Exported (not just used internally) so `automationEditorData.ts`'s
// Behavior-tab consent view can filter the same global lists the same way,
// without re-deriving the matching rule above a second time.
export function filterConsentForAutomation(
  automationName: string,
  blocking: BlockingSummary,
  grants: readonly OutboxGrant[],
): AuConsentDTO {
  const parked = blocking.parked
    .filter((p) => p.callerKind === 'agent' && p.caller === automationName)
    .map((p) => ({
      command: p.command,
      input: p.input,
      invocationId: p.invocationId,
      parkedAt: p.parkedAt,
    }));
  const outbox = blocking.outbox
    .filter((o) => o.actorKind === 'agent' && o.actor === automationName)
    .map((o) => ({
      artifact: o.artifact,
      canEdit: o.canEdit,
      connectionKind: o.connection.kind,
      connectionLabel: o.connection.label,
      itemId: o.itemId,
      note: o.note,
      stagedAt: o.stagedAt,
      status: o.status,
      target: o.target,
      verb: o.verb,
    }));
  // No `actorKind` on a grant row (see note above) — name match only.
  const grantDtos = grants
    .filter((g) => g.actor === automationName)
    .map((g) => ({
      createdAt: g.createdAt,
      grantId: g.grantId,
      revokedAt: g.revokedAt,
      target: g.target,
      verb: g.verb,
    }));
  return { grants: grantDtos, outbox, parked };
}

/** Small-caps mono date-separator label for the thread spine — "Today" /
 *  "Yesterday" / "Mon, Jul 6" (matches the run-view's `startedLabel` day
 *  logic, runViewData.ts, minus the time-of-day suffix). */
function dateGroupLabel(startedAt: number): string {
  const d = new Date(startedAt);
  const now = new Date();
  const ds = d.toDateString();
  if (ds === now.toDateString()) return 'Today';
  if (ds === new Date(now.getTime() - 86_400_000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function buildThreadRun(run: CentraidAutomationRunRecord): ThreadRunDTO {
  const status: ThreadRunStatus = run.endedAt === undefined ? 'running' : run.ok ? 'ok' : 'fail';
  return {
    costUsd: run.totalCostUsd ?? null,
    dateGroup: dateGroupLabel(run.startedAt),
    durationMs: run.endedAt !== undefined ? run.endedAt - run.startedAt : null,
    endedAt: run.endedAt ?? null,
    originLabel: triggerOriginLabel(run).label,
    runId: run.runId,
    startedAt: run.startedAt,
    status,
    summary: run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
  };
}

/**
 * Load one automation's thread: the row, its runs (newest first, capped at
 * 100), and its consent surface filtered down from the global lists. `null`
 * when the automation doesn't exist (deleted, or a stale deep link).
 */
export async function loadAutomationThreadData(input: {
  automationId: string;
  gatewayOrigin: string;
}): Promise<AutomationThreadLoadResult | null> {
  const [row, runs, blocking, grants] = await Promise.all([
    readAutomation({ automationId: input.automationId }),
    listAutomationRuns({ automationId: input.automationId, limit: 100 }),
    getBlocking(),
    listOutboxGrants(),
  ]);
  if (!row) return null;

  const hero = deriveAutomationHero(row, input.gatewayOrigin);
  const statusKind = auStatusForRow(row.enabled, runs.length > 0) as AuStatusKind;

  const header: AutomationThreadHeaderDTO = {
    description: row.manifest.description ?? null,
    enabled: row.enabled,
    glyphIcon: glyphForId(row.id),
    heroIcon: hero.heroIcon,
    hue: hueForId(row.id),
    id: row.id,
    kindEyebrow: hero.kindEyebrow,
    name: row.name,
    nextRuns: hero.nextRuns,
    ref: row.ref,
    statusKind,
    statusLabel: AU_STATUS_LABEL[statusKind],
    triggerSummary: hero.when,
    webhook: hero.webhook,
  };

  return {
    data: {
      consent: filterConsentForAutomation(row.name, blocking, grants),
      header,
      runs: runs
        .slice()
        .sort((a, b) => b.startedAt - a.startedAt)
        .map(buildThreadRun),
    },
    row,
  };
}

/**
 * Thin passthroughs over the three consent-decision endpoints
 * (`decideOutboxItem` / `confirmVaultParked` / `revokeOutboxGrant`), unified
 * behind the one `onDecideConsent(kind, id, decision, alwaysAllow?)` shape
 * `AutomationThreadBridgeProps`/`AutomationEditorBridgeProps` both use.
 * Resolves `true` on a decision the caller should treat as settled (throws
 * on transport failure — the route wrapper catches + toasts, matching the
 * existing `AutomationViewRoute.tsx` pattern).
 */
export async function decideConsentItem(input: {
  kind: ConsentKind;
  id: string;
  decision: ConsentDecision;
  alwaysAllow?: boolean;
}): Promise<boolean> {
  switch (input.kind) {
    case 'outbox': {
      const outcome = await decideOutboxItem({
        decision: input.decision === 'discard' ? 'discard' : 'approve',
        itemId: input.id,
        ...(input.alwaysAllow !== undefined ? { alwaysAllow: input.alwaysAllow } : {}),
      });
      return outcome.status === 'executed';
    }
    case 'parked': {
      await confirmVaultParked({ approve: input.decision !== 'discard', invocationId: input.id });
      return true;
    }
    case 'grant': {
      const outcome = await revokeOutboxGrant(input.id);
      return outcome.status === 'executed';
    }
  }
}
