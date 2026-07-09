// governance: allow-repo-hygiene file-size-limit route-module split out of app.ts (#227)
// Automations route — the Executions overview, the templates gallery, and the
// per-automation + per-run viewers (timeline / transcript). Extracted from the
// app.ts shell IIFE. The cluster is gateway- and formatter-heavy with almost no
// shell-state coupling: it reaches the shell only through the ShellContext
// primitives destructured below (plus `window.openBuilder`, a global set by
// builder.ts). Returns its render entry points so app.ts can bind them onto the
// nav dispatcher, the registry, and the home page's automations section.
import {
  createAutomation,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  readAutomation,
  runAutomationNow,
  setAutomationEnabled,
} from './gateway-client.js';
import { auStatusForRow, glyphForId, hueForId } from './automation-identity.js';
import { requireReactBridge } from './react/bridge.js';
import type { AuOverviewData, AuStatusKind, AutomationViewData } from './react/bridge.js';
import { cronNextRuns } from './cron.js';
import {
  fmtRetention,
  fmtTokens,
  formatDuration,
  relativeRunLabel,
  relativeTime,
  triggersSummary,
} from './app-format.js';
import { createTemplatesGallery } from './app-automations-templates.js';
import { createAutomationsUi, type AuStatus } from './app-automations-ui.js';
import { createRunViewModule } from './app-automations-runview.js';
import type { ShellContext, TemplateEntry } from './app-shell-context.js';

// One execution in the Automations "Executions" feed (issue #91): automations
// are user-owned apps, so a run is identified by its automation id; the display
// name is resolved from the app list. Shared with the home page's overview.
export interface AutomationFeedEntry {
  automationId: string;
  automationName: string;
  run: CentraidAutomationRunRecord;
}

export interface AutomationsModule {
  renderAutomations(): void;
  renderAutomationView(automationId: string): void;
  renderRunView(automationId: string, runId: string): void;
  renderAutomationTemplates(): void;
  createAndOpenAutomationBuilder(): Promise<void>;
  enterAutomationBuilder(input: { automationId: string }): void;
  // Exposed for the home page + discover (which still live in app.ts):
  openAutomationTemplatePreview(template: TemplateEntry): void;
  integrationDots(names: readonly string[]): HTMLElement;
  // Identity/status primitives so Home can build automation cards that match
  // the app-card visual family (the unified "library" shelf).
  autoGlyphTile(id: string, opts?: { size?: number; glyphSize?: number }): HTMLElement;
  auStatusPill(kind: AuStatus, label?: string): HTMLElement;
  renderOverviewAutomationRow(
    row: CentraidAutomationRow,
    lastRun: AutomationFeedEntry | undefined,
  ): HTMLElement;
  renderOverviewRunRow(entry: AutomationFeedEntry): HTMLElement;
  collectAutomationRuns(): Promise<AutomationFeedEntry[]>;
  loadAutomationTemplates(): Promise<TemplateEntry[]>;
}

export function createAutomationsModule(ctx: ShellContext): AutomationsModule {
  const {
    el,
    clear,
    showToast,
    mountShellPage,
    recordRoute,
    registerCleanup,
    chromeNav,
    openConfirm,
    root,
  } = ctx;

  const AU_STATUS_LABEL: Record<AuStatusKind, string> = {
    active: 'Active',
    paused: 'Paused',
    draft: 'Draft',
    running: 'Running',
    success: 'Success',
    failed: 'Failed',
  };

  // Derive the React overview DTO from the loaded rows + run feed. Every display
  // value (hue, glyph, trigger/status labels, formatted run meta) is computed
  // here so the React screen imports no vanilla formatters.
  function buildOverviewData(
    rows: readonly CentraidAutomationRow[],
    entries: readonly AutomationFeedEntry[],
  ): AuOverviewData {
    const runs = entries
      .filter((e) => e.automationId)
      .slice()
      .sort((a, b) => b.run.startedAt - a.run.startedAt);
    const lastByRef = new Map<string, AutomationFeedEntry>();
    for (const e of runs) if (!lastByRef.has(e.automationId)) lastByRef.set(e.automationId, e);

    let active = 0;
    let paused = 0;
    let drafts = 0;
    let attention = 0;
    for (const r of rows) {
      const lastEntry = lastByRef.get(r.ref);
      if (r.enabled) active += 1;
      else if (lastEntry) paused += 1;
      else drafts += 1;
      if (lastEntry && !lastEntry.run.ok) attention += 1;
    }
    const subParts = [`${active} active`, `${paused + drafts} paused`];
    if (runs.length > 0) subParts.push(`${runs.length} recent runs`);

    return {
      health: { active, attention, drafts, paused },
      rows: rows.map((r) => {
        const last = lastByRef.get(r.ref);
        const hasCron = r.triggers.some((t) => t.kind === 'cron');
        const hasWebhook = r.triggers.some((t) => t.kind === 'webhook');
        const statusKind = auStatusForRow(r.enabled, !!last) as AuStatusKind;
        return {
          glyphIcon: glyphForId(r.id),
          hue: hueForId(r.id),
          id: r.id,
          integrations: [...(r.manifest.requires.mcps ?? [])],
          lastRunLabel: last
            ? `Last run ${relativeTime(new Date(last.run.startedAt).toISOString())}`
            : 'No runs yet',
          name: r.name,
          ref: r.ref,
          statusKind,
          statusLabel: AU_STATUS_LABEL[statusKind],
          triggerIcon: hasWebhook && !hasCron ? 'Webhook' : 'Clock',
          triggerLabel: triggersSummary(r.triggers),
        };
      }),
      runs: runs.map((entry) => {
        const { run, automationName, automationId } = entry;
        const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
        const dur = run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : '—';
        return {
          automationId,
          metaLabel: `${run.triggerOrigin ?? run.triggerKind} · ${dur} · ${fmtTokens(tokens)}`,
          name: automationName,
          ok: run.ok,
          runId: run.runId,
          summary: run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
          whenLabel: relativeTime(new Date(run.startedAt).toISOString()),
        };
      }),
      subtitle: rows.length > 0 ? subParts.join('  ·  ') : 'Conversations that run on their own.',
    };
  }

  // Derive the React single-view DTO — hero, run rows, 30-day KPIs, behavior —
  // so the React screen imports no vanilla formatters.
  function buildAutomationViewData(
    row: CentraidAutomationRow,
    runs: readonly CentraidAutomationRunRecord[],
  ): AutomationViewData {
    const hasWebhook = row.triggers.some((t) => t.kind === 'webhook');
    const hasCron = row.triggers.some((t) => t.kind === 'cron');
    const hasRun = runs.length > 0;
    const cronExprs = row.triggers
      .filter((t): t is { kind: 'cron'; expr: string } => t.kind === 'cron')
      .map((t) => t.expr);
    const nextRuns =
      hasCron && cronExprs[0]
        ? cronNextRuns(cronExprs[0], 3).map((dt) => relativeRunLabel(dt))
        : [];

    let webhook: AutomationViewData['webhook'] = null;
    if (hasWebhook) {
      const wh = row.triggers.find((t) => t.kind === 'webhook') as
        | { kind: 'webhook'; id?: string; pending?: true }
        | undefined;
      webhook =
        wh?.pending || !wh?.id
          ? { pending: true, url: null }
          : { pending: false, url: `/_centraid-hook/${wh.id}` };
    }

    const statusKind = auStatusForRow(row.enabled, hasRun) as AuStatusKind;
    const now = Date.now();
    const life = automationLifetime(runs.filter((r) => now - r.startedAt <= 30 * 86_400_000));
    const tools = row.manifest.requires.tools ?? [];

    return {
      behavior: {
        historyLabel: fmtRetention(row.manifest.history.keep),
        model: row.manifest.requires.model ?? row.manifest.costEstimate?.model ?? 'Default',
        onFailure: row.manifest.onFailure ? `Run "${row.manifest.onFailure}"` : 'Stop',
      },
      cronExprs,
      description: row.manifest.description ?? null,
      enabled: row.enabled,
      glyphIcon: glyphForId(row.id),
      heroIcon: hasWebhook && !hasCron ? 'Webhook' : 'Clock',
      hue: hueForId(row.id),
      kindEyebrow: hasWebhook && !hasCron ? 'Webhook' : 'Cron schedule',
      kpis: {
        avg: life.avg,
        cost: life.cost,
        successPct: life.successPct === null ? '—' : `${life.successPct}%`,
        total: String(life.total),
      },
      name: row.name,
      nextRuns,
      runs: runs.map((run) => {
        const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
        const dur =
          run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : 'running';
        const trig =
          run.triggerOrigin === 'webhook'
            ? { icon: 'Webhook', label: 'Webhook' }
            : run.triggerKind === 'manual'
              ? { icon: 'Play', label: 'Manual' }
              : { icon: 'Clock', label: 'Cron' };
        const filterKey: 'cron' | 'webhook' | 'manual' | 'other' =
          run.triggerOrigin === 'webhook'
            ? 'webhook'
            : run.triggerKind === 'scheduled'
              ? 'cron'
              : run.triggerKind === 'manual'
                ? 'manual'
                : 'other';
        return {
          automationId: run.automationId ?? null,
          filterKey,
          metaLabel: `${dur} · ${fmtTokens(tokens)}`,
          ok: run.ok,
          runId: run.runId,
          summary: run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
          trigIcon: trig.icon,
          trigLabel: trig.label,
          whenLabel: relativeTime(new Date(run.startedAt).toISOString()),
        };
      }),
      statusKind,
      statusLabel: AU_STATUS_LABEL[statusKind],
      tools: tools.length > 0 ? [...tools] : [...(row.manifest.requires.mcps ?? [])],
      webhook,
      when: triggersSummary(row.triggers),
    };
  }

  // Templates gallery is its own module; the overview's "Browse templates"
  // action + Discover reach it through these bindings.
  const { renderAutomationTemplates, openAutomationTemplatePreview, loadAutomationTemplates } =
    createTemplatesGallery(ctx);

  // Shared identity/status DOM primitives (also reused by the run-view module).
  const ui = createAutomationsUi(ctx);
  const {
    autoGlyphTile,
    auStatusPill,
    integrationDots,
    renderOverviewAutomationRow,
    renderOverviewRunRow,
  } = ui;

  // The run viewer is its own module; the automation view + overview rows open
  // runs through this binding (and via ctx.shell.renderRunView elsewhere).
  const { renderRunView } = createRunViewModule(ctx, ui);

  // The Automations landing — a single overview rather than the old
  // two-tab (Executions / Standing orders) shell: your automations on
  // the left, the recent-run stream on the right. Each automation opens
  // its viewer; each run opens as a thread.

  function renderAutomations(): void {
    recordRoute({ kind: 'automations' });
    clear();
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);

    // Render the overview via the React screen. The vanilla side fetches +
    // derives the DTO (loadData); React owns loading/error/data + the "View
    // all" toggle.
    mountShellPage('automations', main);
    registerCleanup(
      requireReactBridge().mountAutomationsOverview(scroll, {
        loadData: async () => {
          const [rows, entries] = await Promise.all([listAutomations(), collectAutomationRuns()]);
          return buildOverviewData(rows, entries);
        },
        onBrowseTemplates: () => renderAutomationTemplates(),
        onNewAutomation: () => void createAndOpenAutomationBuilder(),
        onOpenAutomation: (ref) => ctx.shell.renderAutomationView(ref),
        onOpenRun: (automationId, runId) => ctx.shell.renderRunView(automationId, runId),
      }),
    );
  }

  // Scaffold a fresh draft automation, then open the conversational
  // builder on it (issue #98). This replaces the old form-based creation
  // sheet: the user describes the automation in chat and the agent fills
  // in `automation.json` + `handler.js`. The draft is created disabled —
  // the user enables it from the builder once it looks right.
  async function createAndOpenAutomationBuilder(): Promise<void> {
    // An automation is an app folder; the scaffolder marks it as an
    // automation app via `app.json#kind: 'automation'` (issue #98). The id
    // is a plain slug — the kind, not the id, is the automation signal.
    const id = `automation-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await createAutomation({
        id,
        name: 'New automation',
        enabled: false,
      });
    } catch (err) {
      console.error('[automations] could not scaffold draft', err);
      return;
    }
    enterAutomationBuilder({ automationId: id });
  }

  // Open the conversational builder on an existing automation app.
  function enterAutomationBuilder(input: { automationId: string }): void {
    recordRoute({ kind: 'automation-builder', automationId: input.automationId });
    clear();
    if (typeof window.openBuilder !== 'function') {
      console.error('Builder not loaded');
      return;
    }
    ctx.setCurrentCleanup(
      window.openBuilder({
        root,
        el,
        onExit: renderAutomations,
        appId: input.automationId,
        appKind: 'automation',
        ...chromeNav(),
      }) ?? null,
    );
  }

  // ───────────────────────── Automation viewer ─────────────────────
  // A per-automation detail page: the trigger as a sentence, the prompt
  // it runs, and its run history. `automationId` is the `<appId>/<id>`
  // ref. Reached from the standing-order list.

  // Sum/derive the lifetime KPIs shown in the viewer's side rail.
  function automationLifetime(runs: readonly CentraidAutomationRunRecord[]): {
    total: number;
    successPct: number | null;
    avg: string;
    cost: string;
  } {
    const total = runs.length;
    const ok = runs.filter((r) => r.ok).length;
    const durations = runs
      .filter((r) => r.endedAt !== undefined)
      .map((r) => r.endedAt! - r.startedAt);
    const avgMs = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : undefined;
    const cost = runs.reduce((s, r) => s + (r.totalCostUsd ?? 0), 0);
    return {
      total,
      successPct: total ? Math.round((ok / total) * 100) : null,
      avg: avgMs !== undefined ? formatDuration(Math.round(avgMs)) : '—',
      cost: cost > 0 ? `$${cost.toFixed(2)}` : '—',
    };
  }

  function renderAutomationView(automationId: string): void {
    recordRoute({ kind: 'automation-view', automationId });
    clear();
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);

    // Render via the React screen. The vanilla side owns the gateway actions +
    // confirm dialog + the live-streaming run-view handoff; React owns the
    // view, filters, reload.
    mountShellPage('automations', main);
    let currentRow: CentraidAutomationRow | null = null;
    registerCleanup(
      requireReactBridge().mountAutomationView(scroll, {
        loadData: async () => {
          const [row, runs] = await Promise.all([
            readAutomation({ automationId }),
            listAutomationRuns({ automationId, limit: 40 }),
          ]);
          currentRow = row;
          return row ? buildAutomationViewData(row, runs) : null;
        },
        onBack: () => renderAutomations(),
        onCopyWebhook: (url) =>
          void navigator.clipboard
            .writeText(url)
            .then(() => showToast('Webhook URL copied'))
            .catch(() => showToast('Could not copy to clipboard')),
        onDelete: async () => {
          const row = currentRow;
          if (!row) return false;
          const ok = await openConfirm({
            confirmLabel: 'Delete',
            danger: true,
            message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
            title: 'Delete automation?',
          });
          if (!ok) return false;
          try {
            await deleteAutomation({ automationId: row.ref });
            showToast(`Deleted "${row.name}"`);
            renderAutomations();
            return true;
          } catch (err) {
            showToast(
              `Could not delete ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        },
        onEdit: () => {
          if (currentRow) enterAutomationBuilder({ automationId: currentRow.id });
        },
        onOpenRun: (autoId, runId) => renderRunView(autoId, runId),
        onRun: async () => {
          const row = currentRow;
          if (!row) return false;
          try {
            const { runId } = await runAutomationNow({ automationId: row.ref });
            renderRunView(row.ref, runId);
            return true;
          } catch (err) {
            showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        },
        onToggleEnabled: async (next) => {
          const row = currentRow;
          if (!row) return false;
          try {
            await setAutomationEnabled({ automationId: row.ref, enabled: next });
            showToast(
              next ? `Enabled · ${triggersSummary(row.triggers)}` : 'Disabled — schedule stopped',
            );
            return true;
          } catch (err) {
            showToast(
              `Could not ${next ? 'enable' : 'disable'} ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        },
      }),
    );
  }

  // The run viewer (chat thread) lives in app-automations-runview.ts.

  // Collect the global automation-run ledger into one flat list. The
  // run record carries the automation id; the name is resolved from the
  // app list (newest-first sorting is the caller's job).
  async function collectAutomationRuns(): Promise<AutomationFeedEntry[]> {
    let autos: CentraidAutomationRow[] = [];
    let runs: CentraidAutomationRunRecord[] = [];
    try {
      [autos, runs] = await Promise.all([listAutomations(), listAutomationRuns({ limit: 100 })]);
    } catch {
      return [];
    }
    // Run records key the automation by its `<appId>/<id>` handle.
    const nameByRef = new Map(autos.map((a) => [a.ref, a.name]));
    return runs.map((run) => ({
      automationId: run.automationId ?? '',
      automationName: run.automationId
        ? (nameByRef.get(run.automationId) ?? run.automationId)
        : 'Automation',
      run,
    }));
  }

  return {
    renderAutomations,
    renderAutomationView,
    renderRunView,
    renderAutomationTemplates,
    createAndOpenAutomationBuilder,
    enterAutomationBuilder,
    openAutomationTemplatePreview,
    integrationDots,
    autoGlyphTile,
    auStatusPill,
    renderOverviewAutomationRow,
    renderOverviewRunRow,
    collectAutomationRuns,
    loadAutomationTemplates,
  };
}
