import { DAY_MS } from "@centraid/blueprints/apps/_shared/format-kit";

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

export interface AutomationThreadLoadResult {
  row: CentraidAutomationRow;
  data: AutomationThreadData;
}

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

function dateGroupLabel(startedAt: number): string {
  const d = new Date(startedAt);
  const now = new Date();
  const ds = d.toDateString();
  if (ds === now.toDateString()) return "Today";
  if (ds === new Date(now.getTime() - DAY_MS).toDateString())
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
  const compiles = runs
    .filter((run) => run.triggerKind === "compile")
    .sort((a, b) => b.startedAt - a.startedAt);
  const threadTurns = runs.filter((run) => run.triggerKind !== "compile");
  const executions = threadTurns.filter(
    (run) => run.triggerKind !== "interactive"
  );
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
