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
import {
  auStatusForRow,
  glyphForId,
  hueForId,
} from "../../../automation-identity.js";
import {
  confirmVaultParked,
  decideOutboxItem,
  getBlocking,
  listAutomationTurns,
  listAgents,
  listOutboxGrants,
  readAutomation,
  revokeOutboxGrant,
} from "../../../gateway-client.js";
import type { BlockingSummary, OutboxGrant } from "../../../gateway-client.js";
import type {
  AuConsentDTO,
  AuPlanStatusDTO,
  AuStatusKind,
  AutomationThreadData,
  AutomationThreadHeaderDTO,
  ConsentDecision,
  ConsentKind,
  ThreadRunDTO,
  ThreadRunStatus,
} from "../../screen-contracts.js";
import {
  AU_STATUS_LABEL,
  deriveAutomationHero,
  triggerOriginLabel,
} from "./automationsData.js";

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
//     (packages/server/src/serve/build-gateway.ts:1157-1166:
//     `vaultRegistry.enrollAutomationAgent(appId, nameByOwnerApp.get(appId))`
//     where `appId` iterates `new Set(rows.map((r) => r.ownerApp))`).
//   - `enrollAutomationAgent` calls `ensureAgentEnrolled(db, appId, {
//     displayName })` (packages/server/src/serve/vault-plane.ts:520-526),
//     which stores `appId` as `consent_agent.enrollment_key` and `displayName`
//     (== the automation's manifest `name`, same value `row.name` carries)
//     as `core_party.display_name` — self-healing on rename
//     (packages/vault/src/host.ts:415-455).
//
// None of the three consent surfaces expose that `ownerApp`/enrollment_key to the
// renderer, and only two of them expose the enrolled agent's row id at all:
//   - `OutboxItem` (an outbox-staged write) carries only `actor` (the
//     resolved DISPLAY NAME) and `actorKind` — `OutboxItemSummary`
//     (vault-plane.ts:227-242) never puts `actor_id` on the wire.
//   - `OutboxGrant.actorId` and `VaultParkedEntry.callerId` DO carry the raw
//     `consent_agent.agent_id` (vault-plane.ts `listOutboxGrants`;
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
// grant here). A follow-up that exposes `consent_agent.agent_id` (e.g. a
// renderer `listAgents()` client fn over the existing
// `/centraid/_vault/agents` route) would let this become an exact id match.
// Exported (not just used internally) so `automationEditorData.ts`'s
// Behavior-tab consent view can filter the same global lists the same way,
// without re-deriving the matching rule above a second time.
export function filterConsentForAutomation(
  agentId: string | undefined,
  blocking: BlockingSummary,
  grants: readonly OutboxGrant[]
): AuConsentDTO {
  const parked = blocking.parked
    .filter((p) => p.callerKind === "agent" && p.callerId === agentId)
    .map((p) => ({
      command: p.command,
      input: p.input,
      invocationId: p.invocationId,
      parkedAt: p.parkedAt,
    }));
  const outbox = blocking.outbox
    .filter((o) => o.actorKind === "agent" && o.actorId === agentId)
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
  const grantDtos = grants
    .filter((g) => g.actorId === agentId)
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
  if (ds === now.toDateString()) return "Today";
  if (ds === new Date(now.getTime() - 86_400_000).toDateString())
    return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function buildThreadRun(run: CentraidAutomationTurnRecord): ThreadRunDTO {
  const status: ThreadRunStatus =
    run.endedAt === undefined ? "running" : run.ok ? "ok" : "fail";
  return {
    costUsd: run.totalCostUsd ?? null,
    dateGroup: dateGroupLabel(run.startedAt),
    durationMs: run.endedAt === undefined ? null : run.endedAt - run.startedAt,
    endedAt: run.endedAt ?? null,
    entryKind: run.triggerKind === "interactive" ? "ask" : "run",
    originLabel: triggerOriginLabel(run).label,
    runId: run.turnId,
    startedAt: run.startedAt,
    status,
    summary: run.ok ? (run.summary ?? "—") : (run.error ?? "Failed"),
  };
}

/**
 * What the run screen may say about the compiled plan.
 *
 * The latest compile turn is the whole story: in flight ⇒ the plan is being
 * rebuilt, failed ⇒ executions are running against a stale plan (or none),
 * ok ⇒ nothing to report. `never` is a real state, not an error — an
 * automation that has been saved but never compiled cannot run at all, and
 * saying so here is kinder than an empty run list.
 *
 * Deliberately inert: no turn id, no retry handle. Every remedy the banner
 * offers is a link to the compiler screen, which owns compiling.
 */
function buildPlanStatus(
  compiles: readonly CentraidAutomationTurnRecord[],
  hasRun: boolean
): AuPlanStatusDTO {
  const latest = compiles[0];
  if (!latest) {
    return hasRun
      ? { detail: null, label: "Plan ready", state: "ready" }
      : {
          detail:
            "This automation has never been compiled, so it has nothing to run yet.",
          label: "No plan yet",
          state: "never",
        };
  }
  if (latest.endedAt === undefined) {
    return {
      detail: "Building a new plan from the instructions.",
      label: "Compiling…",
      state: "compiling",
    };
  }
  if (!latest.ok) {
    return {
      detail:
        latest.error ??
        "The compiler could not turn these instructions into a plan.",
      label: "Compile failed",
      state: "failed",
    };
  }
  return {
    detail: `Compiled ${relativeCompileTime(latest.startedAt)}.`,
    label: "Plan ready",
    state: "ready",
  };
}

function relativeCompileTime(startedAt: number): string {
  const mins = Math.round((Date.now() - startedAt) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
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
  const [row, runs, blocking, grants, agents] = await Promise.all([
    readAutomation({ automationId: input.automationId }),
    listAutomationTurns({ automationId: input.automationId, limit: 100 }),
    getBlocking(),
    listOutboxGrants(),
    listAgents(),
  ]);
  if (!row) return null;

  const hero = deriveAutomationHero(row, input.gatewayOrigin);
  // The one place the two surfaces are cut apart. A compile turn is the
  // COMPILER working, not the automation running: it never belongs in the run
  // history, where it used to sit as a "Compile" card among real executions.
  // It is distilled into `plan` (an inert status the run screen may report and
  // must not act on) and otherwise handed to the compiler screen, which reads
  // the same turns as steps via automationCompileData.ts.
  const compiles = runs
    .filter((run) => run.triggerKind === "compile")
    .sort((a, b) => b.startedAt - a.startedAt);
  const threadTurns = runs.filter((run) => run.triggerKind !== "compile");
  const executions = threadTurns.filter(
    (run) => run.triggerKind !== "interactive"
  );
  // Header status now reports the AUTOMATION, not its last compile — the plan
  // banner carries compile state, and duplicating it in the header badge is
  // what made "Compile failed" read like a run outcome.
  const statusKind = auStatusForRow(
    row.enabled,
    executions.length > 0
  ) as AuStatusKind;
  const statusLabel = AU_STATUS_LABEL[statusKind];

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
    statusLabel,
    triggerSummary: hero.when,
    webhook: hero.webhook,
    entityTags: Array.from(
      (row.manifest.prompt ?? "").matchAll(
        /@\[(?<entityType>[^/\]]+)\/(?<entityId>[^\]]+)\]/gu
      ),
      (match) => ({
        type: match.groups?.entityType ?? "",
        id: match.groups?.entityId ?? "",
      })
    ),
  };

  return {
    data: {
      consent: filterConsentForAutomation(
        agents.find((agent) => agent.enrollmentKey === row.ownerApp)?.agentId,
        blocking,
        grants
      ),
      header,
      plan: buildPlanStatus(compiles, executions.length > 0),
      ...(row.manifest.enrich?.delegateStep
        ? {
            recognition: {
              capability: row.manifest.enrich.capability,
              selected: row.manifest.enrich.delegateStep.selected,
              deterministicLabel: "Deterministic service",
              delegate: {
                model: row.manifest.requires.model ?? null,
                latency: row.manifest.enrich.delegateStep.latency,
                consequence: row.manifest.enrich.delegateStep.consequence,
              },
            },
          }
        : {}),
      runs: threadTurns
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
    case "outbox": {
      const outcome = await decideOutboxItem({
        decision: input.decision === "discard" ? "discard" : "approve",
        itemId: input.id,
        ...(input.alwaysAllow === undefined
          ? {}
          : { alwaysAllow: input.alwaysAllow }),
      });
      return outcome.status === "executed";
    }
    case "parked": {
      await confirmVaultParked({
        approve: input.decision !== "discard",
        invocationId: input.id,
      });
      return true;
    }
    case "grant": {
      const outcome = await revokeOutboxGrant(input.id);
      return outcome.status === "executed";
    }
  }
}
