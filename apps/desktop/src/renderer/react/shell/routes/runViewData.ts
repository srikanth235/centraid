// Run-view snapshot derivation — ports the vanilla app-automations-runview.ts
// `buildRunSnapshot`. Pure: turns the live run model (row + run record + node
// map + streamed text) into the RunViewSnapshot the RunViewScreen renders in
// both timeline + log modes, so the screen imports no vanilla formatters.
import {
  fmtTokens,
  formatDuration,
  nodeRunStatus,
  prettyJson,
  runTriggerLabel,
  triggersSummary,
} from '../../../app-format.js';
import { glyphForId, hueForId } from '../../../automation-identity.js';
import type { AuStatusKind, RunLogRowDTO, RunNodeDTO, RunViewSnapshot } from '../../screen-contracts.js';

const NODE_TYPE_ICON: Record<string, string> = {
  trigger: 'Bolt',
  step: 'Activity',
  tool: 'Plug',
  agent: 'Sparkle',
  invoke: 'Cpu',
};

export function buildRunSnapshot(
  row: CentraidAutomationRow,
  run: CentraidAutomationRunRecord,
  nodes: readonly CentraidAutomationRunNode[],
  liveText: Map<number, string>,
): RunViewSnapshot {
  const inFlight = run.endedAt === undefined;
  const model = row.manifest.requires.model ?? 'Centraid';
  const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
  const duration =
    run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : 'running';
  const statusKind: AuStatusKind = inFlight ? 'running' : run.ok ? 'success' : 'failed';
  const statusLabel = inFlight ? 'Running' : run.ok ? 'Completed' : 'Failed';
  const hasWebhook =
    row.triggers.some((t) => t.kind === 'webhook') && !row.triggers.some((t) => t.kind === 'cron');
  const startedLabel = ((): string => {
    const d = new Date(run.startedAt);
    const nowMs = Date.now();
    const ds = d.toDateString();
    const day =
      ds === new Date(nowMs).toDateString()
        ? 'Today'
        : ds === new Date(nowMs - 86_400_000).toDateString()
          ? 'Yesterday'
          : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    return `${day}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
  })();

  const runNodes: RunNodeDTO[] = nodes.map((node) => {
    const status = nodeRunStatus(node) as 'running' | 'ok' | 'fail';
    const t = (node.inputTokens ?? 0) + (node.outputTokens ?? 0);
    const metaParts: string[] = [];
    if (node.durationMs !== undefined) metaParts.push(formatDuration(node.durationMs));
    else if (status === 'running') metaParts.push('running…');
    if (t > 0) metaParts.push(`${fmtTokens(t)} tok`);
    const live = liveText.get(node.ordinal);
    const isAgent = node.kind === 'agent';
    return {
      error: node.error,
      input: !isAgent && node.argsJson ? prettyJson(node.argsJson) : undefined,
      kind: node.kind,
      liveText: live,
      meta: metaParts.join('  ·  '),
      name: node.name ?? node.model ?? node.kind,
      ordinal: node.ordinal,
      output: !isAgent && node.outputJson ? prettyJson(node.outputJson) : undefined,
      response: isAgent
        ? (live ?? (node.outputJson ? prettyJson(node.outputJson) : undefined))
        : undefined,
      status,
      streaming: !!live && node.endedAt === undefined,
      typeIcon: NODE_TYPE_ICON[node.kind] ?? 'Activity',
    };
  });

  const origin = run.triggerOrigin ?? (run.triggerKind === 'manual' ? 'manual' : 'cron');
  const trig =
    origin === 'webhook'
      ? { icon: 'Webhook', label: 'Webhook' }
      : origin === 'manual'
        ? { icon: 'Play', label: 'Manual' }
        : { icon: 'Clock', label: 'Cron' };
  const start = run.startedAt;
  const elapsed = (ms: number): string => {
    const d = Math.max(0, ms - start);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(Math.floor(d / 60_000))}:${pad(Math.floor((d % 60_000) / 1000))}.${Math.floor((d % 1000) / 100)}`;
  };
  const startedBy =
    origin === 'webhook'
      ? 'Run started by webhook'
      : origin === 'manual'
        ? 'Run started manually'
        : 'Run started by cron';
  const logRows: RunLogRowDTO[] = [
    {
      label: startedBy,
      sub: triggersSummary(row.triggers),
      time: elapsed(run.startedAt),
      tone: 'trigger',
    },
    ...nodes.map((node): RunLogRowDTO => {
      const status = nodeRunStatus(node);
      const isAgent = node.kind === 'agent';
      return {
        error: node.error,
        input: !isAgent && node.argsJson ? prettyJson(node.argsJson) : undefined,
        label: node.name ?? node.model ?? node.kind,
        output: !isAgent && node.outputJson ? prettyJson(node.outputJson) : undefined,
        response: isAgent
          ? (liveText.get(node.ordinal) ?? (node.outputJson ? prettyJson(node.outputJson) : undefined))
          : undefined,
        sub: node.kind,
        time: elapsed(node.startedAt),
        tone: status,
      };
    }),
    ...(inFlight
      ? []
      : [
          {
            error: run.ok ? undefined : (run.error ?? 'No error detail was recorded.'),
            label: run.ok ? 'Run completed' : 'Run failed',
            sub: run.ok ? (run.summary ?? undefined) : undefined,
            time: elapsed(run.endedAt ?? Date.now()),
            tone: run.ok ? 'ok' : 'fail',
          } as RunLogRowDTO,
        ]),
  ];

  return {
    crumbName: row.name,
    final: inFlight
      ? { kind: 'pending', model }
      : run.ok
        ? {
            kind: 'ok',
            model,
            output: run.outputJson ? prettyJson(run.outputJson) : undefined,
            summary: run.summary ?? undefined,
          }
        : { error: run.error ?? undefined, kind: 'fail', model },
    glyphIcon: glyphForId(row.id),
    headerName: row.name,
    hue: hueForId(row.id),
    inFlight,
    logKpi: {
      cost: run.totalCostUsd !== undefined ? `$${run.totalCostUsd.toFixed(3)}` : '—',
      duration,
      tokens: fmtTokens(tokens),
      triggerIcon: trig.icon,
      triggerLabel: trig.label,
    },
    logRows,
    model,
    nodes: runNodes,
    promptInstr: row.manifest.prompt || 'No instructions.',
    side: {
      cost: run.totalCostUsd ? `$${run.totalCostUsd.toFixed(2)}` : '—',
      duration,
      model,
      outcomeKind: statusKind,
      outcomeLabel: statusLabel,
      runId: run.runId,
      started: new Date(run.startedAt).toLocaleString(),
      steps: String(run.stepCount ?? nodes.length),
      tokens: fmtTokens(tokens),
      trigger: run.triggerOrigin ?? run.triggerKind,
    },
    startedLabel,
    statusKind,
    statusLabel,
    triggerHeroIcon: hasWebhook ? 'Webhook' : 'Clock',
    triggerLabel: runTriggerLabel(run),
    triggersSummary: triggersSummary(row.triggers),
  };
}
