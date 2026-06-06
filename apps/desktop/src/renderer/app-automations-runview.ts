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
import type { AutomationsUi } from './app-automations-ui.js';
import type { ShellContext } from './app-shell-context.js';

export interface RunViewModule {
  renderRunView(automationId: string, runId: string): void;
}

export function createRunViewModule(ctx: ShellContext, ui: AutomationsUi): RunViewModule {
  const { el, clear, showToast, registerCleanup, recordRoute, mountShellPage } = ctx;
  const { auStatusPill, autoGlyphTile } = ui;

  // Node-type → glyph, for the run timeline (Direction A).
  const NODE_TYPE_ICON: Record<string, IconNameType> = {
    trigger: 'Bolt',
    step: 'Activity',
    tool: 'Plug',
    agent: 'Sparkle',
    invoke: 'Cpu',
  };

  // One node of a run rendered as a timeline card: a rail circle (status
  // glyph) + connector on the left, an expandable card on the right.
  // Collapsed shows status·name·dur·tokens·chevron; expanded shows JSON
  // args/output (tool/step), the agent response (agent), or a red error box.
  function renderTimelineNode(node: CentraidAutomationRunNode, liveText?: string): HTMLElement {
    const status = nodeRunStatus(node);
    const item = el('div', { class: 'cd-au-tl-item', 'data-status': status });

    const railIcon =
      status === 'running'
        ? Icon.Loader({ size: 12 })
        : status === 'ok'
          ? Icon.CheckCircle({ size: 13 })
          : Icon.AlertTriangle({ size: 13 });
    item.append(
      el('span', { class: 'cd-au-tl-rail', 'aria-hidden': 'true' }, [
        el('span', {
          class: 'cd-au-tl-dot',
          'data-spin': status === 'running' ? 'true' : undefined,
          trustedHtml: railIcon,
        }),
        el('span', { class: 'cd-au-tl-line' }),
      ]),
    );

    const tokens = (node.inputTokens ?? 0) + (node.outputTokens ?? 0);
    const metaParts: string[] = [];
    if (node.durationMs !== undefined) metaParts.push(formatDuration(node.durationMs));
    else if (status === 'running') metaParts.push('running…');
    if (tokens > 0) metaParts.push(`${fmtTokens(tokens)} tok`);

    const card = el('div', { class: 'cd-au-tl-card', 'data-status': status });
    const head = el('button', {
      class: 'cd-au-tl-head',
      type: 'button',
      'aria-expanded': 'false',
    }) as HTMLButtonElement;
    head.append(
      el('span', {
        class: 'cd-au-tl-type',
        'aria-hidden': 'true',
        trustedHtml: Icon[NODE_TYPE_ICON[node.kind] ?? 'Activity']({ size: 13 }),
      }),
      el('span', { class: 'cd-au-tl-name' }, node.name ?? node.model ?? node.kind),
      el('span', { class: 'cd-au-tl-kind' }, node.kind),
      el('span', { class: 'cd-au-tl-meta' }, metaParts.join('  ·  ') || '—'),
      el('span', {
        class: 'cd-au-tl-chev',
        'aria-hidden': 'true',
        trustedHtml: Icon.ChevronRight({ size: 14 }),
      }),
    );
    const body = el('div', { class: 'cd-au-tl-body', hidden: 'true' });
    let built = false;
    const buildBody = (): void => {
      if (built) return;
      built = true;
      if (node.error) body.append(el('div', { class: 'cd-au-tl-error' }, node.error));
      if (node.kind === 'agent') {
        const text = liveText ?? (node.outputJson ? prettyJson(node.outputJson) : '');
        if (text) body.append(el('div', { class: 'cd-au-tl-response' }, text));
      } else {
        if (node.argsJson) {
          body.append(
            el('div', { class: 'cd-au-step-label' }, 'Input'),
            el('pre', { class: 'cd-au-step-pre' }, prettyJson(node.argsJson)),
          );
        }
        if (node.outputJson) {
          body.append(
            el('div', { class: 'cd-au-step-label' }, 'Output'),
            el('pre', { class: 'cd-au-step-pre' }, prettyJson(node.outputJson)),
          );
        }
      }
      if (!body.hasChildNodes()) {
        body.append(el('div', { class: 'cd-au-step-empty' }, 'No payload recorded.'));
      }
    };
    head.addEventListener('click', () => {
      const open = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!open));
      body.hidden = open;
      if (!open) buildBody();
    });
    card.append(head, body);

    // While an agent node is in flight, stream its assistant text live with a
    // blinking caret (the `node.delta` deltas accumulated by the viewer).
    if (liveText && node.endedAt === undefined) {
      card.append(
        el('div', { class: 'cd-au-tl-stream' }, [
          el('span', { class: 'cd-au-tl-stream-tx' }, liveText),
          el('span', { class: 'cd-au-tl-caret', 'aria-hidden': 'true' }),
        ]),
      );
    }

    item.append(card);
    return item;
  }

  function renderRunView(automationId: string, runId: string): void {
    recordRoute({ kind: 'run-view', automationId, runId });
    clear();
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);
    scroll.append(el('div', { class: 'cd-au-loading' }, 'Loading run…'));
    mountShellPage('automations', main);

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
      if (stopped || !document.contains(scroll) || !row || !run) return;
      // Keep scroll position so a live update doesn't yank the page.
      const prevTop = scroll.scrollTop;
      scroll.replaceChildren(buildRunView(row, run, sortedNodes(), liveTextByOrdinal, rerender));
      scroll.scrollTop = prevTop;
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

  function buildRunView(
    row: CentraidAutomationRow,
    run: CentraidAutomationRunRecord,
    nodes: readonly CentraidAutomationRunNode[],
    liveText?: Map<number, string>,
    rerender?: () => void,
  ): HTMLElement {
    const wrap = el('div', { class: 'cd-au-rv' });
    const triggerLabel = runTriggerLabel(run);
    const model = row.manifest.requires.model ?? 'Centraid';
    // A run with no `endedAt` is still executing — the viewer polls and
    // re-renders it until it finishes.
    const inFlight = run.endedAt === undefined;

    // ── Breadcrumb ──
    wrap.append(
      el('div', { class: 'cd-au-crumb' }, [
        el(
          'button',
          { type: 'button', onClick: () => ctx.shell.renderAutomations() },
          'Automations',
        ),
        el('span', { class: 'cd-au-crumb-sep', trustedHtml: Icon.ArrowRight({ size: 12 }) }),
        el(
          'button',
          { type: 'button', onClick: () => ctx.shell.renderAutomationView(row.ref) },
          row.name,
        ),
        el('span', { class: 'cd-au-crumb-sep', trustedHtml: Icon.ArrowRight({ size: 12 }) }),
        el('span', {}, 'Run'),
      ]),
    );

    // ── Header ──
    const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
    const duration =
      run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : 'running';
    const runAgain = el('button', {
      class: 'cd-au-btn cd-au-btn-ghost cd-au-btn-sm',
      type: 'button',
      trustedHtml: `${Icon.Reset({ size: 13 })}<span>Run again</span>`,
    }) as HTMLButtonElement;
    runAgain.addEventListener('click', () => {
      runAgain.disabled = true;
      void (async () => {
        try {
          const { runId } = await runAutomationNow({ automationId: row.ref });
          renderRunView(row.ref, runId);
        } catch (err) {
          runAgain.disabled = false;
          showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });

    const grid = el('div', { class: 'cd-au-rv-grid' });
    const detailsBtn = el('button', {
      class: 'cd-au-btn cd-au-btn-ghost cd-au-btn-sm',
      type: 'button',
      trustedHtml: `${Icon.Eye({ size: 13 })}<span>Hide details</span>`,
    }) as HTMLButtonElement;
    detailsBtn.addEventListener('click', () => {
      const narrow = grid.classList.toggle('cd-au-rv-grid--narrow');
      detailsBtn.querySelector('span')!.textContent = narrow ? 'Show details' : 'Hide details';
    });

    // A/B view toggle — Timeline (rail + KPI) vs Log (single-column transcript).
    const modeSeg = el('div', { class: 'cd-au-rv-seg', role: 'tablist', 'aria-label': 'Run view' });
    for (const opt of [
      { k: 'timeline', label: 'Timeline', icon: 'Activity' },
      { k: 'log', label: 'Log', icon: 'Braces' },
    ] as const) {
      modeSeg.append(
        el('button', {
          class: 'cd-au-rv-seg-b',
          type: 'button',
          role: 'tab',
          'data-active': runViewMode === opt.k ? 'true' : undefined,
          'aria-selected': String(runViewMode === opt.k),
          trustedHtml: `${Icon[opt.icon]({ size: 12 })}<span>${opt.label}</span>`,
          onClick: () => {
            if (runViewMode === opt.k) return;
            runViewMode = opt.k;
            Store.set('automations.runViewMode', opt.k);
            rerender?.();
          },
        }),
      );
    }

    const headStatus = inFlight
      ? auStatusPill('running')
      : auStatusPill(run.ok ? 'success' : 'failed', run.ok ? 'Completed' : 'Failed');
    // Subtitle reads like the spec: "Today, 6:00:02 PM · <model>". Trigger,
    // tokens, duration and outcome live in the KPI strip (log mode) or the
    // right rail (timeline), so the header stays a clean when + model line.
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
      const time = d.toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      });
      return `${day}, ${time}`;
    })();
    wrap.append(
      el('div', { class: 'cd-au-rv-head' }, [
        autoGlyphTile(row.id, { size: 42, glyphSize: 19 }),
        el('div', { class: 'cd-au-rv-head-main' }, [
          el('div', { class: 'cd-au-rv-head-name' }, [row.name, headStatus]),
          el('div', { class: 'cd-au-rv-head-meta' }, `${startedLabel}  ·  ${model}`),
        ]),
        el('div', { class: 'cd-au-actions' }, [
          modeSeg,
          ...(runViewMode === 'timeline' ? [detailsBtn] : []),
          runAgain,
        ]),
      ]),
    );

    // ── Direction B — single-column transcript log. ──
    if (runViewMode === 'log') {
      wrap.append(buildRunTranscript(row, run, nodes, liveText));
      return wrap;
    }

    // ── Timeline (Direction A) ── vertical rail of node cards. The trigger
    // opens it, each run node is a card, and the run settles into a final
    // outcome node (or a pulsing pending node while still in flight).
    const timeline = el('div', { class: 'cd-au-tl' });

    // Trigger node — the instruction that kicked the run off (always open).
    const trigInstr = el(
      'div',
      { class: 'cd-au-trig-instr cd-au-trig-instr--open' },
      row.manifest.prompt || 'No instructions.',
    );
    timeline.append(
      el('div', { class: 'cd-au-tl-item', 'data-status': 'trigger' }, [
        el('span', { class: 'cd-au-tl-rail', 'aria-hidden': 'true' }, [
          el('span', {
            class: 'cd-au-tl-dot',
            trustedHtml:
              run.triggerOrigin === 'webhook'
                ? Icon.Webhook({ size: 13 })
                : Icon.Clock({ size: 13 }),
          }),
          el('span', { class: 'cd-au-tl-line' }),
        ]),
        el('div', { class: 'cd-au-tl-card cd-au-tl-card-trigger' }, [
          el('div', { class: 'cd-au-tl-trig-head' }, [
            el('span', { class: 'cd-au-tl-trig-label' }, triggerLabel),
            el('time', {}, new Date(run.startedAt).toLocaleString()),
          ]),
          el('div', { class: 'cd-au-trig-line' }, [
            el('span', { 'aria-hidden': 'true', trustedHtml: Icon.Clock({ size: 14 }) }),
            triggersSummary(row.triggers),
          ]),
          trigInstr,
        ]),
      ]),
    );

    // Run nodes.
    for (const node of nodes) {
      timeline.append(renderTimelineNode(node, liveText?.get(node.ordinal)));
    }

    // Final outcome node — pending (in flight), success, or failure.
    if (inFlight) {
      timeline.append(
        el('div', { class: 'cd-au-tl-item cd-au-tl-item-final', 'data-status': 'running' }, [
          el('span', { class: 'cd-au-tl-rail', 'aria-hidden': 'true' }, [
            el('span', {
              class: 'cd-au-tl-dot',
              'data-spin': 'true',
              trustedHtml: Icon.Loader({ size: 12 }),
            }),
          ]),
          el('div', { class: 'cd-au-tl-card', 'data-status': 'running' }, [
            el('div', { class: 'cd-au-tl-head cd-au-tl-head-static' }, [
              el('span', {
                class: 'cd-au-tl-type',
                'aria-hidden': 'true',
                trustedHtml: Icon.Sparkle({ size: 13 }),
              }),
              el('span', { class: 'cd-au-tl-name' }, `Centraid · ${model}`),
            ]),
            el('div', { class: 'cd-au-pending' }, [
              el('span', { class: 'cd-au-pending-dots', 'aria-hidden': 'true' }, [
                el('i', {}),
                el('i', {}),
                el('i', {}),
              ]),
              el('span', {}, 'Working — this updates live as the run progresses.'),
            ]),
          ]),
        ]),
      );
    } else {
      const finalStatus = run.ok ? 'ok' : 'fail';
      const finalBody = el('div', { class: 'cd-au-tl-final-body' });
      if (run.ok) {
        finalBody.append(
          el('p', { class: 'cd-au-reply-lead' }, run.summary ?? 'The run completed.'),
        );
        if (run.outputJson) {
          finalBody.append(
            el('div', { class: 'cd-au-step-label' }, 'Output'),
            el('pre', { class: 'cd-au-step-pre' }, prettyJson(run.outputJson)),
          );
        }
      } else {
        finalBody.append(
          el('p', { class: 'cd-au-reply-lead' }, 'This run did not complete.'),
          el('div', { class: 'cd-au-tl-error' }, run.error ?? 'No error detail was recorded.'),
        );
      }
      timeline.append(
        el('div', { class: 'cd-au-tl-item cd-au-tl-item-final', 'data-status': finalStatus }, [
          el('span', { class: 'cd-au-tl-rail', 'aria-hidden': 'true' }, [
            el('span', {
              class: 'cd-au-tl-dot',
              trustedHtml: run.ok
                ? Icon.CheckCircle({ size: 13 })
                : Icon.AlertTriangle({ size: 13 }),
            }),
          ]),
          el('div', { class: 'cd-au-tl-card', 'data-status': finalStatus }, [
            el('div', { class: 'cd-au-tl-head cd-au-tl-head-static' }, [
              el('span', {
                class: 'cd-au-tl-type',
                'aria-hidden': 'true',
                trustedHtml: run.ok ? Icon.Sparkle({ size: 13 }) : Icon.AlertTriangle({ size: 13 }),
              }),
              el('span', { class: 'cd-au-tl-name' }, run.ok ? `Centraid · ${model}` : 'Run failed'),
            ]),
            finalBody,
          ]),
        ]),
      );
    }

    // ── Side rail ──
    const railRow = (k: string, v: string): HTMLElement =>
      el('div', { class: 'cd-au-rside-row' }, [
        el('span', { class: 'cd-au-rside-k' }, k),
        el('span', { class: 'cd-au-rside-v' }, v),
      ]);
    const side = el('div', { class: 'cd-au-rside' }, [
      el('div', { class: 'cd-au-rside-card' }, [
        el('div', { class: 'cd-au-rside-h' }, 'Run detail'),
        el('div', { class: 'cd-au-rside-row' }, [
          el('span', { class: 'cd-au-rside-k' }, 'Outcome'),
          inFlight
            ? auStatusPill('running')
            : auStatusPill(run.ok ? 'success' : 'failed', run.ok ? 'Completed' : 'Failed'),
        ]),
        railRow('Trigger', run.triggerOrigin ?? run.triggerKind),
        railRow('Duration', duration),
        railRow('Started', new Date(run.startedAt).toLocaleString()),
        railRow('Run ID', run.runId),
      ]),
      el('div', { class: 'cd-au-rside-card' }, [
        el('div', { class: 'cd-au-rside-h' }, 'Usage'),
        railRow('Tokens', fmtTokens(tokens)),
        railRow('Cost', run.totalCostUsd ? `$${run.totalCostUsd.toFixed(2)}` : '—'),
        railRow('Steps', String(run.stepCount ?? nodes.length)),
        railRow('Model', model),
      ]),
      el('div', { class: 'cd-au-rside-card' }, [
        el('div', { class: 'cd-au-rside-h' }, 'Belongs to'),
        el(
          'button',
          {
            class: 'cd-au-rside-link',
            type: 'button',
            onClick: () => ctx.shell.renderAutomationView(row.ref),
          },
          [el('span', {}, row.name), el('span', { trustedHtml: Icon.ArrowRight({ size: 14 }) })],
        ),
      ]),
    ]);

    grid.append(el('div', { class: 'cd-au-rv-thread-col' }, [timeline]), side);
    wrap.append(grid);
    return wrap;
  }

  // ── Run viewer Direction B — single-column transcript log ──
  // A dense, chronological log: a mono KPI line, then one row per event
  // (trigger · each node · outcome) with a timestamp gutter and inline
  // payloads. No rail, no KPI sidebar — the alternate to the timeline.
  function buildRunTranscript(
    row: CentraidAutomationRow,
    run: CentraidAutomationRunRecord,
    nodes: readonly CentraidAutomationRunNode[],
    liveText?: Map<number, string>,
  ): HTMLElement {
    const wrap = el('div', { class: 'cd-au-log' });
    const start = run.startedAt;
    const inFlight = run.endedAt === undefined;
    const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
    const fmtClock = (ms: number): string =>
      new Date(ms).toLocaleTimeString(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
      });
    // The gutter reads elapsed time since the run began (mm:ss.t), so the
    // column tells the run's internal cadence rather than wall-clock noise.
    const fmtElapsed = (ms: number): string => {
      const d = Math.max(0, ms - start);
      const pad = (n: number): string => String(n).padStart(2, '0');
      return `${pad(Math.floor(d / 60_000))}:${pad(Math.floor((d % 60_000) / 1000))}.${Math.floor((d % 1000) / 100)}`;
    };

    // ── KPI strip: Trigger · Tokens · Cost · Duration · Outcome ──
    const origin = run.triggerOrigin ?? (run.triggerKind === 'manual' ? 'manual' : 'cron');
    const trig =
      origin === 'webhook'
        ? { icon: 'Webhook' as const, label: 'Webhook' }
        : origin === 'manual'
          ? { icon: 'Play' as const, label: 'Manual' }
          : { icon: 'Clock' as const, label: 'Cron' };
    const durTxt =
      run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : 'running';
    const costTxt = run.totalCostUsd !== undefined ? `$${run.totalCostUsd.toFixed(3)}` : '—';
    const stat = (label: string, value: string | HTMLElement): HTMLElement =>
      el('div', { class: 'cd-au-log-stat' }, [
        el('div', { class: 'cd-au-log-stat-l' }, label),
        el('div', { class: 'cd-au-log-stat-v' }, [value]),
      ]);
    wrap.append(
      el('div', { class: 'cd-au-log-stats' }, [
        stat(
          'Trigger',
          el('span', { class: 'cd-au-log-stat-trig' }, [
            el('span', {
              class: 'cd-au-log-stat-ic',
              'aria-hidden': 'true',
              trustedHtml: Icon[trig.icon]({ size: 13 }),
            }),
            el('span', {}, trig.label),
          ]),
        ),
        stat('Tokens', fmtTokens(tokens)),
        stat('Cost', costTxt),
        stat('Duration', durTxt),
        stat(
          'Outcome',
          inFlight
            ? auStatusPill('running')
            : auStatusPill(run.ok ? 'success' : 'failed', run.ok ? 'Success' : 'Failed'),
        ),
      ]),
    );

    // ── Transcript panel ──
    const panel = el('div', { class: 'cd-au-log-panel' });
    wrap.append(panel);

    const logRow = (
      time: string,
      tone: string,
      head: HTMLElement,
      body?: HTMLElement,
    ): HTMLElement => {
      const main = el('div', { class: 'cd-au-log-main' }, [head]);
      if (body) main.append(body);
      return el('div', { class: 'cd-au-log-row', 'data-tone': tone }, [
        el('span', { class: 'cd-au-log-time' }, time),
        main,
      ]);
    };

    // Collapsible payload chip — "{ } args ⌄" toggles a JSON block below it,
    // keeping the transcript scannable until a payload is actually wanted.
    const payloadChip = (label: string, json: string): { chip: HTMLElement; pre: HTMLElement } => {
      const pre = el('pre', { class: 'cd-au-log-pre' }, prettyJson(json)) as HTMLElement;
      pre.hidden = true;
      const chip = el('button', {
        class: 'cd-au-log-chip',
        type: 'button',
        'aria-expanded': 'false',
        trustedHtml: `${Icon.Braces({ size: 11 })}<span>${label}</span>`,
      }) as HTMLButtonElement;
      chip.append(
        el('span', {
          class: 'cd-au-log-chip-chev',
          'aria-hidden': 'true',
          trustedHtml: Icon.ChevronDown({ size: 12 }),
        }),
      );
      chip.addEventListener('click', () => {
        const open = pre.hidden;
        pre.hidden = !open;
        chip.setAttribute('aria-expanded', String(open));
        chip.classList.toggle('cd-au-log-chip--open', open);
      });
      return { chip, pre };
    };

    // Trigger row — "▶ Run started by cron   <expr> · <time>".
    const cronExpr =
      run.triggerOrigin === 'webhook'
        ? undefined
        : row.triggers.find((t): t is { kind: 'cron'; expr: string } => t.kind === 'cron')?.expr;
    const startedBy =
      origin === 'webhook'
        ? 'Run started by webhook'
        : origin === 'manual'
          ? 'Run started manually'
          : 'Run started by cron';
    panel.append(
      logRow(
        fmtElapsed(run.startedAt),
        'trigger',
        el('div', { class: 'cd-au-log-head' }, [
          el('span', {
            class: 'cd-au-log-glyph',
            'data-status': 'trigger',
            'aria-hidden': 'true',
            trustedHtml: Icon.Play({ size: 12 }),
          }),
          el('span', { class: 'cd-au-log-name' }, startedBy),
          el(
            'span',
            { class: 'cd-au-log-meta' },
            `${cronExpr ?? trig.label.toLowerCase()}  ·  ${fmtClock(run.startedAt)}`,
          ),
        ]),
      ),
    );

    // Node rows.
    for (const node of nodes) {
      const status = nodeRunStatus(node);
      const tk = (node.inputTokens ?? 0) + (node.outputTokens ?? 0);
      const meta: string[] = [];
      if (node.durationMs !== undefined) meta.push(formatDuration(node.durationMs));
      else if (status === 'running') meta.push('running…');
      if (tk > 0) meta.push(`${fmtTokens(tk)} tok`);
      const head = el('div', { class: 'cd-au-log-head' }, [
        el('span', {
          class: 'cd-au-log-glyph',
          'data-status': status,
          'data-spin': status === 'running' ? 'true' : undefined,
          'aria-hidden': 'true',
          trustedHtml:
            status === 'running'
              ? Icon.Loader({ size: 12 })
              : status === 'ok'
                ? Icon.CheckCircle({ size: 12 })
                : Icon.AlertTriangle({ size: 12 }),
        }),
        el('span', { class: 'cd-au-log-kind' }, node.kind),
        el('span', { class: 'cd-au-log-name' }, node.name ?? node.model ?? node.kind),
        el('span', { class: 'cd-au-log-meta' }, meta.join('  ·  ')),
      ]);

      const body = el('div', { class: 'cd-au-log-body' });
      const live = liveText?.get(node.ordinal);
      if (node.error) body.append(el('div', { class: 'cd-au-tl-error' }, node.error));
      if (node.kind === 'agent') {
        // The agent's reply streams live, then settles to its recorded output.
        const text = live ?? (node.outputJson ? prettyJson(node.outputJson) : '');
        if (text) body.append(el('div', { class: 'cd-au-log-reply' }, text));
      } else {
        const payloads: Array<[string, string]> = [];
        if (node.argsJson) payloads.push(['args', node.argsJson]);
        if (node.outputJson) payloads.push(['out', node.outputJson]);
        if (payloads.length > 0) {
          const chips = el('div', { class: 'cd-au-log-chips' });
          const pres = el('div', { class: 'cd-au-log-pres' });
          for (const [label, json] of payloads) {
            const { chip, pre } = payloadChip(label, json);
            chips.append(chip);
            pres.append(pre);
          }
          body.append(chips, pres);
        }
      }
      panel.append(
        logRow(fmtElapsed(node.startedAt), status, head, body.hasChildNodes() ? body : undefined),
      );
    }

    // Footer — live spinner while running, else one settled summary line that
    // mirrors the spec's "✓ Run finished · <summary>".
    if (inFlight) {
      panel.append(
        logRow(
          '··',
          'running',
          el('div', { class: 'cd-au-log-head' }, [
            el('span', {
              class: 'cd-au-log-glyph',
              'data-status': 'running',
              'data-spin': 'true',
              'aria-hidden': 'true',
              trustedHtml: Icon.Loader({ size: 12 }),
            }),
            el('span', { class: 'cd-au-log-name' }, 'Working — updates live'),
          ]),
        ),
      );
    } else {
      const foot = el('div', { class: 'cd-au-log-foot', 'data-status': run.ok ? 'ok' : 'fail' });
      foot.append(
        el('span', {
          class: 'cd-au-log-foot-ic',
          'aria-hidden': 'true',
          trustedHtml: run.ok ? Icon.CheckCircle({ size: 14 }) : Icon.AlertTriangle({ size: 14 }),
        }),
        el(
          'span',
          { class: 'cd-au-log-foot-tx' },
          run.ok
            ? `Run finished${run.summary ? ` · ${run.summary}` : ''}`
            : (run.error ?? 'Run failed — no error detail recorded.'),
        ),
      );
      if (run.ok && run.outputJson) {
        // Keep the raw output reachable without cluttering the summary line.
        const { chip, pre } = payloadChip('out', run.outputJson);
        foot.append(chip);
        panel.append(foot, el('div', { class: 'cd-au-log-foot-pre' }, [pre]));
      } else {
        panel.append(foot);
      }
    }
    return wrap;
  }

  return { renderRunView };
}
