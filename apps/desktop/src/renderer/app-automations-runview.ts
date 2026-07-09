// governance: allow-repo-hygiene file-size-limit route-module split out of app.ts (#227)
// The run viewer — a single automation run rendered as a thread: the trigger,
// the agent's work folded into a collapsible n8n-style step timeline, and the
// final reply, with live streaming while the run is in flight. Split out of
// app-automations.ts (the largest sub-surface). Reaches the shell through
// ShellContext primitives, the shared automation UI (auStatusPill/autoGlyphTile),
// and ctx.shell.{renderAutomationView,renderAutomations} for back-navigation.
import {
  listAutomationRunNodes,
  readAutomation,
  readAutomationRun,
  runAutomationNow,
  streamAutomationRun,
  type RunStreamEvent,
} from './gateway-client.js';
import {
  fmtTokens,
  formatDuration,
  nodeRunStatus,
  prettyJson,
  runTriggerLabel,
  triggersSummary,
} from './app-format.js';
import { glyphForId, hueForId } from './automation-identity.js';
import { requireReactBridge } from './react/bridge.js';
import type { ShellContext } from './app-shell-context.js';
import type { AuStatusKind, RunLogRowDTO, RunNodeDTO, RunViewSnapshot } from './react/bridge.js';

export interface RunViewModule {
  renderRunView(automationId: string, runId: string): void;
}

export function createRunViewModule(ctx: ShellContext): RunViewModule {
  const { el, clear, showToast, registerCleanup, recordRoute, mountShellPage } = ctx;

  // Node-type → glyph, for the run timeline (Direction A).
  const NODE_TYPE_ICON: Record<string, IconNameType> = {
    trigger: 'Bolt',
    step: 'Activity',
    tool: 'Plug',
    agent: 'Sparkle',
    invoke: 'Cpu',
  };

  // Derive the React run-view snapshot from the live model (issue #325). Mirrors
  // buildRunView / buildRunTranscript / renderTimelineNode so the React screen
  // renders both modes without touching the vanilla formatters.
  function buildRunSnapshot(
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
      row.triggers.some((t) => t.kind === 'webhook') &&
      !row.triggers.some((t) => t.kind === 'cron');
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
            ? (liveText.get(node.ordinal) ??
              (node.outputJson ? prettyJson(node.outputJson) : undefined))
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

  function renderRunView(automationId: string, runId: string): void {
    recordRoute({ kind: 'run-view', automationId, runId });
    clear();
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);
    scroll.append(el('div', { class: 'cd-au-loading' }, 'Loading run…'));
    mountShellPage('automations', main);

    // Render via the React RunViewScreen. The vanilla side keeps the SSE stream
    // + node model below and pushes a derived snapshot to React on each event
    // (see `rerender`).
    let reactUpdate: ((s: RunViewSnapshot | null) => void) | null = null;
    scroll.replaceChildren();
    registerCleanup(
      requireReactBridge().mountRunView(scroll, {
        initialMode: runViewMode,
        onBack: () => ctx.shell.renderAutomations(),
        onOpenAutomation: () => {
          if (row) ctx.shell.renderAutomationView(row.ref);
        },
        onReady: (u) => {
          reactUpdate = u;
        },
        onRunAgain: () => {
          if (!row) return;
          const ref = row.ref;
          void runAutomationNow({ automationId: ref })
            .then(({ runId: rid }) => renderRunView(ref, rid))
            .catch((err: unknown) =>
              showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`),
            );
        },
        onSetMode: (m) => {
          runViewMode = m;
          Store.set('automations.runViewMode', m);
        },
      }),
    );

    // The run streams live over SSE (issue #158): the gateway replays the
    // durable ledger, then pushes each node lifecycle event until `run.end`.
    // No more 1.5s polling — we keep a local node model keyed by ordinal and
    // re-render on each event.
    let stopped = false;
    const ac = new AbortController();
    registerCleanup(() => {
      stopped = true;
      ac.abort();
    });

    let row: CentraidAutomationRow | null = null;
    let run: CentraidAutomationRunRecord | null = null;
    const nodesByOrdinal = new Map<number, CentraidAutomationRunNode>();
    // Accumulated streaming text per node ordinal (Phase 2 `node.delta`).
    const liveTextByOrdinal = new Map<number, string>();

    const sortedNodes = (): CentraidAutomationRunNode[] =>
      [...nodesByOrdinal.values()].sort((a, b) => a.ordinal - b.ordinal);

    const rerender = (): void => {
      if (stopped || !document.contains(scroll) || !row || !run || !reactUpdate) return;
      reactUpdate(buildRunSnapshot(row, run, sortedNodes(), liveTextByOrdinal));
    };

    const applyEvent = (ev: RunStreamEvent): void => {
      if (ev.type === 'node.start') {
        const prev = nodesByOrdinal.get(ev.ordinal);
        nodesByOrdinal.set(ev.ordinal, {
          nodeId: prev?.nodeId ?? `${runId}:${ev.ordinal}`,
          runId,
          ordinal: ev.ordinal,
          ...(ev.batchId !== undefined ? { batchId: ev.batchId } : {}),
          kind: ev.kind,
          ...(ev.name !== undefined ? { name: ev.name } : {}),
          ...(ev.args !== undefined ? { argsJson: JSON.stringify(ev.args) } : {}),
          ok: true, // provisional until node.end
          startedAt: prev?.startedAt ?? Date.now(),
        });
        rerender();
      } else if (ev.type === 'node.end') {
        const prev = nodesByOrdinal.get(ev.ordinal);
        const startedAt = prev?.startedAt ?? Date.now() - ev.durationMs;
        nodesByOrdinal.set(ev.ordinal, {
          nodeId: prev?.nodeId ?? `${runId}:${ev.ordinal}`,
          runId,
          ordinal: ev.ordinal,
          ...(prev?.batchId !== undefined ? { batchId: prev.batchId } : {}),
          kind: prev?.kind ?? 'tool',
          ...(prev?.name !== undefined ? { name: prev.name } : {}),
          ...(prev?.argsJson !== undefined ? { argsJson: prev.argsJson } : {}),
          ...(ev.result !== undefined ? { outputJson: JSON.stringify(ev.result) } : {}),
          ok: ev.ok,
          ...(ev.error !== undefined ? { error: ev.error } : {}),
          startedAt,
          endedAt: startedAt + ev.durationMs,
          durationMs: ev.durationMs,
        });
        rerender();
      } else if (ev.type === 'run.end') {
        // Refetch the authoritative final run record (summary / output /
        // rollup) + persisted nodes, then render the settled run.
        void (async () => {
          const [finalRun, finalNodes] = await Promise.all([
            readAutomationRun({ runId }).catch(() => null),
            listAutomationRunNodes({ runId }).catch(() => []),
          ]);
          if (stopped) return;
          if (finalRun) run = finalRun;
          else if (run)
            run = {
              ...run,
              ok: ev.ok,
              endedAt: Date.now(),
              ...(ev.error ? { error: ev.error } : {}),
            };
          if (finalNodes.length > 0) {
            nodesByOrdinal.clear();
            for (const n of finalNodes) nodesByOrdinal.set(n.ordinal, n);
          }
          rerender();
        })();
      } else if (ev.type === 'node.delta') {
        // Phase 2: accumulate the agent turn's streamed assistant text so the
        // in-flight node card shows tokens as they arrive.
        const inner = ev.event as { type?: string; delta?: string };
        if (inner?.type === 'assistant.delta' && typeof inner.delta === 'string') {
          liveTextByOrdinal.set(
            ev.ordinal,
            (liveTextByOrdinal.get(ev.ordinal) ?? '') + inner.delta,
          );
          rerender();
        }
      }
      // run.start: nothing to render.
    };

    void (async () => {
      try {
        [row, run] = await Promise.all([
          readAutomation({ automationId }),
          readAutomationRun({ runId }),
        ]);
      } catch (err) {
        if (!stopped && document.contains(scroll)) {
          scroll.replaceChildren(
            el(
              'div',
              { class: 'cd-au-loading' },
              `Could not load run: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        return;
      }
      if (stopped || !document.contains(scroll)) return;
      if (!row) {
        scroll.replaceChildren(el('div', { class: 'cd-au-loading' }, 'Run not found.'));
        return;
      }
      // The ledger row may lag a just-fired run by a few ms; synthesize an
      // in-flight header so the viewer renders immediately. run.end refetches
      // the authoritative record.
      if (!run) {
        run = {
          runId,
          kind: 'automation',
          automationId,
          triggerKind: 'manual',
          startedAt: Date.now(),
          ok: false,
          pinned: false,
        };
      }
      rerender();
      try {
        await streamAutomationRun(runId, applyEvent, ac.signal);
      } catch {
        // Stream couldn't be established — fall back to a one-shot ledger read
        // so the timeline still shows (e.g. an older gateway without the SSE
        // endpoint).
        if (stopped) return;
        const [fr, fn] = await Promise.all([
          readAutomationRun({ runId }).catch(() => run),
          listAutomationRunNodes({ runId }).catch(() => [] as CentraidAutomationRunNode[]),
        ]);
        if (fr) run = fr;
        nodesByOrdinal.clear();
        for (const n of fn) nodesByOrdinal.set(n.ordinal, n);
        rerender();
      }
    })();
  }

  // Run viewer direction — A 'timeline' (rail + KPI sidebar, default) or
  // B 'log' (single-column transcript). Persisted so the choice sticks.
  let runViewMode: 'timeline' | 'log' = Store.get<'timeline' | 'log'>(
    'automations.runViewMode',
    'timeline',
  );

  return { renderRunView };
}
