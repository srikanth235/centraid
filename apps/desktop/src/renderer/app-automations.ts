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
import { auStatusForRow, hueForId } from './automation-identity.js';
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
import { createAutomationsUi } from './app-automations-ui.js';
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
  renderOverviewAutomationRow(
    row: CentraidAutomationRow,
    lastRun: AutomationFeedEntry | undefined,
  ): HTMLElement;
  renderOverviewRunRow(entry: AutomationFeedEntry): HTMLElement;
  collectAutomationRuns(): Promise<AutomationFeedEntry[]>;
  loadAutomationTemplates(): Promise<TemplateEntry[]>;
}

export function createAutomationsModule(ctx: ShellContext): AutomationsModule {
  const { el, clear, showToast, mountShellPage, recordRoute, chromeNav, openConfirm, root } = ctx;

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
  // Skeleton placeholder rows shown while the overview loads — keeps the
  // page shape stable instead of a bare "Loading…" string.
  function automationsSkeleton(): HTMLElement {
    const wrap = el('div', { class: 'cd-au-ov' });
    wrap.append(el('div', { class: 'cd-au-skel-strip', 'aria-hidden': 'true' }));
    const list = el('div', { class: 'cd-au-ov-list', 'aria-hidden': 'true' });
    for (let i = 0; i < 4; i += 1) list.append(el('div', { class: 'cd-au-skel-row' }));
    wrap.append(
      el('div', { class: 'cd-au-loading-label', role: 'status' }, 'Loading automations…'),
      list,
    );
    return wrap;
  }

  function renderAutomations(): void {
    recordRoute({ kind: 'automations' });
    clear();
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);
    scroll.append(automationsSkeleton());
    mountShellPage('automations', main);
    void (async () => {
      let rows: CentraidAutomationRow[] = [];
      let entries: AutomationFeedEntry[] = [];
      try {
        [rows, entries] = await Promise.all([listAutomations(), collectAutomationRuns()]);
      } catch (err) {
        if (document.contains(scroll)) {
          scroll.replaceChildren(
            el('div', { class: 'cd-au-error' }, [
              el('div', {
                class: 'cd-au-error-icon',
                'aria-hidden': 'true',
                trustedHtml: Icon.AlertCircle({ size: 22 }),
              }),
              el('div', { class: 'cd-au-error-title' }, "Couldn't load automations"),
              el(
                'div',
                { class: 'cd-au-error-text' },
                err instanceof Error ? err.message : String(err),
              ),
              el('button', {
                class: 'cd-au-btn cd-au-btn-primary',
                type: 'button',
                trustedHtml: `${Icon.Refresh({ size: 14 })}<span>Retry</span>`,
                onClick: () => renderAutomations(),
              }),
            ]),
          );
        }
        return;
      }
      if (!document.contains(scroll)) return;
      scroll.replaceChildren(buildAutomationsOverview(rows, entries));
    })();
  }

  // Header actions shared by the overview and its empty state.
  function automationsHeaderActions(): HTMLElement {
    return el('div', { class: 'cd-au-actions' }, [
      el('button', {
        class: 'cd-au-btn cd-au-btn-ghost',
        type: 'button',
        trustedHtml: `${Icon.Bolt({ size: 14 })}<span>Browse templates</span>`,
        onClick: () => renderAutomationTemplates(),
      }),
      el('button', {
        class: 'cd-au-btn cd-au-btn-primary',
        type: 'button',
        trustedHtml: `${Icon.Sparkle({ size: 14 })}<span>New automation</span>`,
        onClick: () => void createAndOpenAutomationBuilder(),
      }),
    ]);
  }

  function buildAutomationsOverview(
    rows: readonly CentraidAutomationRow[],
    entries: readonly AutomationFeedEntry[],
  ): HTMLElement {
    const wrap = el('div', { class: 'cd-au-ov' });

    // Recent runs — automation fires only, newest first.
    const runs = entries
      .filter((e) => e.automationId)
      .slice()
      .sort((a, b) => b.run.startedAt - a.run.startedAt);
    // Most-recent run per automation, for the "last run" line.
    const lastByRef = new Map<string, AutomationFeedEntry>();
    for (const e of runs) if (!lastByRef.has(e.automationId)) lastByRef.set(e.automationId, e);

    // Health tallies. paused vs draft splits the disabled set by whether the
    // automation has ever run; "need attention" is anything whose last run
    // failed (regardless of enabled state).
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

    wrap.append(
      el('div', { class: 'cd-au-ov-head' }, [
        el('div', {}, [
          el('h1', { class: 'cd-au-ov-title' }, 'Automations'),
          el(
            'p',
            { class: 'cd-au-ov-sub' },
            rows.length > 0 ? subParts.join('  ·  ') : 'Conversations that run on their own.',
          ),
        ]),
        automationsHeaderActions(),
      ]),
    );

    if (rows.length > 0) {
      const healthTile = (
        icon: IconNameType,
        value: number,
        label: string,
        tone: 'active' | 'paused' | 'draft' | 'attention',
      ): HTMLElement =>
        el('div', { class: 'cd-au-health-tile', 'data-tone': tone }, [
          el('span', {
            class: 'cd-au-health-ic',
            'aria-hidden': 'true',
            trustedHtml: Icon[icon]({ size: 16 }),
          }),
          el('div', { class: 'cd-au-health-meta' }, [
            el('span', { class: 'cd-au-health-v' }, String(value)),
            el('span', { class: 'cd-au-health-k' }, label),
          ]),
        ]);
      wrap.append(
        el('div', { class: 'cd-au-health' }, [
          healthTile('Power', active, 'Active', 'active'),
          healthTile('Pause', paused, 'Paused', 'paused'),
          healthTile('Pencil', drafts, 'Drafts', 'draft'),
          healthTile('AlertTriangle', attention, 'Need attention', 'attention'),
        ]),
      );
    }

    if (rows.length === 0) {
      wrap.append(
        el('div', { class: 'cd-au-empty' }, [
          el('div', { class: 'cd-au-empty-icon', trustedHtml: Icon.Bolt({ size: 22 }) }),
          el('div', { class: 'cd-au-empty-title' }, 'No automations yet'),
          el(
            'div',
            { class: 'cd-au-empty-text' },
            'An automation is a saved conversation that fires on a trigger. Start from a template, or describe one from scratch.',
          ),
        ]),
      );
      return wrap;
    }

    // Your automations — full-width list.
    wrap.append(
      el('div', { class: 'cd-au-ov-sec' }, [
        el('span', { class: 'cd-au-ov-sec-t' }, 'Your automations'),
        el('span', { class: 'cd-au-ov-sec-m' }, String(rows.length)),
      ]),
      el(
        'div',
        { class: 'cd-au-ov-list' },
        rows.map((r) => renderOverviewAutomationRow(r, lastByRef.get(r.ref))),
      ),
    );

    // Recent runs — a full-width section BELOW the automations list (not a
    // right-hand pane). "View all" expands the capped feed to full history.
    const RUN_CAP = 6;
    const runsSection = el('div', { class: 'cd-au-ov-runs' });
    const paintRuns = (expanded: boolean): void => {
      const header = el('div', { class: 'cd-au-ov-sec' }, [
        el('span', { class: 'cd-au-ov-sec-t' }, 'Recent runs'),
        ...(runs.length > 0 ? [el('span', { class: 'cd-au-ov-sec-m' }, String(runs.length))] : []),
      ]);
      if (runs.length > RUN_CAP) {
        header.append(
          el('button', {
            class: 'cd-au-ov-viewall',
            type: 'button',
            trustedHtml: expanded
              ? '<span>Show less</span>'
              : `<span>View all</span>${Icon.ChevronRight({ size: 13 })}`,
            onClick: () => paintRuns(!expanded),
          }),
        );
      }
      const shown = expanded ? runs : runs.slice(0, RUN_CAP);
      const stream = runs.length
        ? el('div', { class: 'cd-au-ov-stream' }, shown.map(renderOverviewRunRow))
        : el('div', { class: 'cd-au-ov-stream cd-au-ov-stream-empty' }, 'No runs recorded yet.');
      runsSection.replaceChildren(header, stream);
    };
    paintRuns(false);
    wrap.append(runsSection);
    return wrap;
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

  // One run in the viewer's history list — opens as a chat thread. Layout:
  // status icon · summary (red on failure) · trigger badge · time over
  // duration·tokens.
  function renderAuRunRow(run: CentraidAutomationRunRecord): HTMLElement {
    const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
    const dur = run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : 'running';
    const trig: { icon: IconNameType; label: string } =
      run.triggerOrigin === 'webhook'
        ? { icon: 'Webhook', label: 'Webhook' }
        : run.triggerKind === 'manual'
          ? { icon: 'Play', label: 'Manual' }
          : { icon: 'Clock', label: 'Cron' };
    return el(
      'button',
      {
        class: 'cd-au-run',
        type: 'button',
        'data-ok': String(run.ok),
        onClick: () => {
          if (run.automationId) renderRunView(run.automationId, run.runId);
        },
      },
      [
        el('span', {
          class: 'cd-au-run-ic',
          'data-ok': String(run.ok),
          'aria-hidden': 'true',
          trustedHtml: run.ok ? Icon.CheckCircle({ size: 15 }) : Icon.AlertCircle({ size: 15 }),
        }),
        el(
          'span',
          { class: 'cd-au-run-sum' },
          run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
        ),
        el('span', { class: 'cd-au-run-trig' }, [
          el('span', { 'aria-hidden': 'true', trustedHtml: Icon[trig.icon]({ size: 12 }) }),
          el('span', {}, trig.label),
        ]),
        el('span', { class: 'cd-au-run-when' }, [
          el('b', {}, relativeTime(new Date(run.startedAt).toISOString())),
          el('span', { class: 'cd-au-run-when-meta' }, `${dur} · ${fmtTokens(tokens)}`),
        ]),
      ],
    );
  }

  function renderAutomationView(automationId: string): void {
    recordRoute({ kind: 'automation-view', automationId });
    clear();
    const main = el('div', { class: 'has-wall' });
    const scroll = el('div', { class: 'cd-main-scroll' });
    main.append(scroll);
    scroll.append(el('div', { class: 'cd-au-loading' }, 'Loading automation…'));
    mountShellPage('automations', main);
    void (async () => {
      let row: CentraidAutomationRow | null = null;
      let runs: CentraidAutomationRunRecord[] = [];
      try {
        [row, runs] = await Promise.all([
          readAutomation({ automationId }),
          listAutomationRuns({ automationId, limit: 40 }),
        ]);
      } catch (err) {
        if (document.contains(scroll)) {
          scroll.replaceChildren(
            el(
              'div',
              { class: 'cd-au-loading' },
              `Could not load automation: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        return;
      }
      if (!document.contains(scroll)) return;
      if (!row) {
        scroll.replaceChildren(el('div', { class: 'cd-au-loading' }, 'Automation not found.'));
        return;
      }
      scroll.replaceChildren(buildAutomationView(row, runs));
    })();
  }

  function buildAutomationView(
    row: CentraidAutomationRow,
    runs: readonly CentraidAutomationRunRecord[],
  ): HTMLElement {
    const view = el('div', { class: 'cd-au-view' });
    const hasWebhook = row.triggers.some((t) => t.kind === 'webhook');
    const hasCron = row.triggers.some((t) => t.kind === 'cron');

    // ── Breadcrumb + header ──
    const crumb = el('div', { class: 'cd-au-crumb' }, [
      el('button', { type: 'button', onClick: () => renderAutomations() }, 'Automations'),
      el('span', { class: 'cd-au-crumb-sep', trustedHtml: Icon.ArrowRight({ size: 12 }) }),
      el('span', {}, row.name),
    ]);

    const hasRun = runs.length > 0;
    // Title: glyph tile + name; the one-line description rides beneath it.
    // The status pill is NOT here — it lives in the trigger hero (top-right).
    const title = el('div', { class: 'cd-au-vtitle' }, [
      autoGlyphTile(row.id, { size: 46, glyphSize: 21 }),
      el('div', { class: 'cd-au-vtitle-text' }, [
        el('h1', {}, row.name),
        ...(row.manifest.description
          ? [el('p', { class: 'cd-au-vsub' }, row.manifest.description)]
          : []),
      ]),
    ]);

    const deleteBtn = el('button', {
      class: 'cd-au-btn cd-au-btn-danger cd-au-btn-icon',
      type: 'button',
      title: 'Delete automation',
      'aria-label': `Delete ${row.name}`,
      trustedHtml: Icon.Trash({ size: 15 }),
    }) as HTMLButtonElement;
    deleteBtn.addEventListener('click', () => {
      void (async () => {
        const ok = await openConfirm({
          title: 'Delete automation?',
          message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        deleteBtn.disabled = true;
        editBtn.disabled = true;
        runBtn.disabled = true;
        try {
          await deleteAutomation({ automationId: row.ref });
          showToast(`Deleted "${row.name}"`);
          renderAutomations();
        } catch (err) {
          deleteBtn.disabled = false;
          editBtn.disabled = false;
          runBtn.disabled = false;
          showToast(
            `Could not delete ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    });
    const editBtn = el('button', {
      class: 'cd-au-btn cd-au-btn-ghost cd-au-btn-icon',
      type: 'button',
      title: 'Edit in builder',
      trustedHtml: Icon.Pencil({ size: 15 }),
      onClick: () => enterAutomationBuilder({ automationId: row.id }),
    }) as HTMLButtonElement;
    const runBtn = el('button', {
      class: 'cd-au-btn cd-au-btn-primary',
      type: 'button',
      trustedHtml: `${Icon.Play({ size: 14 })}<span>Run now</span>`,
    }) as HTMLButtonElement;
    runBtn.addEventListener('click', () => {
      runBtn.disabled = true;
      runBtn.querySelector('span')!.textContent = 'Starting…';
      void (async () => {
        try {
          const { runId } = await runAutomationNow({ automationId: row.ref });
          // Hand off to the run viewer, which streams the run live.
          renderRunView(row.ref, runId);
        } catch (err) {
          runBtn.disabled = false;
          runBtn.querySelector('span')!.textContent = 'Run now';
          showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    });
    const header = el('div', { class: 'cd-au-vhead' }, [
      el('div', {}, [crumb, title]),
      el('div', { class: 'cd-au-actions' }, [deleteBtn, editBtn, runBtn]),
    ]);
    view.append(header);

    // ── Trigger hero ── (Direction A centrepiece). Identity hue tints the
    // big icon + a 3px rail; the schedule reads as a display-font headline;
    // cron shows the raw expression + next-3-runs pills; webhook shows the
    // endpoint URL with copy + a server-side-secret note (or provisioning).
    const cronExprs = row.triggers
      .filter((t): t is { kind: 'cron'; expr: string } => t.kind === 'cron')
      .map((t) => t.expr);
    const triggerDetail = el('div', { class: 'cd-au-hero-detail' });
    if (hasCron) {
      for (const expr of cronExprs) {
        triggerDetail.append(
          el('span', { class: 'cd-au-hero-cron' }, [
            el('span', {
              class: 'cd-au-hero-cron-ic',
              'aria-hidden': 'true',
              trustedHtml: Icon.Braces({ size: 12 }),
            }),
            el('code', {}, expr),
          ]),
        );
      }
    }

    // Next-3-runs pills (cron only) — relative day labels, first one active.
    const nextRuns = el('div', { class: 'cd-au-hero-next' });
    if (hasCron && cronExprs[0]) {
      const upcoming = cronNextRuns(cronExprs[0], 3);
      if (upcoming.length > 0) {
        nextRuns.append(el('div', { class: 'cd-au-hero-next-lbl' }, 'Next 3 runs'));
        const pills = el('div', { class: 'cd-au-hero-next-pills' });
        upcoming.forEach((d, i) => {
          pills.append(
            el(
              'span',
              { class: 'cd-au-hero-next-pill', 'data-active': i === 0 ? 'true' : undefined },
              [
                el('i', { class: 'cd-au-hero-next-dot', 'aria-hidden': 'true' }),
                el('span', {}, relativeRunLabel(d)),
              ],
            ),
          );
        });
        nextRuns.append(pills);
      }
    }

    // Webhook endpoint row — URL + copy + "secret minted server-side", or a
    // provisioning state while the endpoint spins up. The secret itself is
    // minted server-side and never returned in full.
    let webhookRow: HTMLElement | null = null;
    if (hasWebhook) {
      const wh = row.triggers.find((t) => t.kind === 'webhook') as
        | { kind: 'webhook'; id?: string; pending?: true }
        | undefined;
      if (wh?.pending || !wh?.id) {
        webhookRow = el('div', { class: 'cd-au-hero-webhook', 'data-provisioning': 'true' }, [
          el('span', {
            class: 'cd-au-status-ic',
            'data-spin': 'true',
            'aria-hidden': 'true',
            trustedHtml: Icon.Loader({ size: 13 }),
          }),
          el('span', {}, 'Provisioning endpoint…  ·  secret minted server-side'),
        ]);
      } else {
        const hookPath = `/_centraid-hook/${wh.id}`;
        const copyBtn = el('button', {
          class: 'cd-au-hero-copy',
          type: 'button',
          'aria-label': 'Copy webhook URL',
          title: 'Copy webhook URL',
          trustedHtml: Icon.Copy({ size: 13 }),
        });
        copyBtn.addEventListener('click', () => {
          void navigator.clipboard
            .writeText(hookPath)
            .then(() => showToast('Webhook URL copied'))
            .catch(() => showToast('Could not copy to clipboard'));
        });
        webhookRow = el('div', { class: 'cd-au-hero-webhook' }, [
          el('span', {
            class: 'cd-au-hero-wh-ic',
            'aria-hidden': 'true',
            trustedHtml: Icon.Webhook({ size: 14 }),
          }),
          el('code', { class: 'cd-au-hero-wh-url' }, hookPath),
          copyBtn,
          el('span', { class: 'cd-au-hero-wh-note' }, [
            el('span', { 'aria-hidden': 'true', trustedHtml: Icon.Key({ size: 12 }) }),
            'Secret minted server-side',
          ]),
        ]);
      }
    }

    // Enable switch — role=switch with aria-checked, draft→Enabling…→active
    // lifecycle, spec toasts, revert-on-error. The CTA accent stays --accent.
    const statusToggle = el('label', {
      class: 'cd-au-switch',
      title: row.enabled ? 'Disable' : 'Enable',
    });
    const toggleInput = el('input', { type: 'checkbox', role: 'switch' }) as HTMLInputElement;
    toggleInput.checked = row.enabled;
    toggleInput.setAttribute('aria-checked', String(row.enabled));
    toggleInput.setAttribute('aria-label', `${row.enabled ? 'Disable' : 'Enable'} ${row.name}`);
    toggleInput.addEventListener('change', () => {
      const next = toggleInput.checked;
      toggleInput.disabled = true;
      void (async () => {
        try {
          await setAutomationEnabled({ automationId: row.ref, enabled: next });
          showToast(
            next ? `Enabled · ${triggersSummary(row.triggers)}` : 'Disabled — schedule stopped',
          );
          renderAutomationView(row.ref);
        } catch (err) {
          // Revert to the previous state + name the cause.
          toggleInput.checked = row.enabled;
          toggleInput.setAttribute('aria-checked', String(row.enabled));
          toggleInput.disabled = false;
          showToast(
            `Could not ${next ? 'enable' : 'disable'} ${row.name}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    });
    statusToggle.append(
      toggleInput,
      el('span', { class: 'cd-au-switch-track', 'aria-hidden': 'true' }),
    );

    const heroMain = el('div', { class: 'cd-au-hero-main' }, [
      el(
        'div',
        { class: 'cd-au-hero-eyebrow cd-au-hero-kind' },
        hasWebhook && !hasCron ? 'Webhook' : 'Cron schedule',
      ),
      el('div', { class: 'cd-au-hero-when' }, triggersSummary(row.triggers)),
      triggerDetail,
    ]);
    if (nextRuns.childElementCount > 0) heroMain.append(nextRuns);
    if (webhookRow) heroMain.append(webhookRow);

    const hero = el('div', { class: 'cd-au-hero', 'data-hue': hueForId(row.id) }, [
      el('span', {
        class: 'cd-au-hero-icon',
        'aria-hidden': 'true',
        trustedHtml: hasWebhook && !hasCron ? Icon.Webhook({ size: 26 }) : Icon.Clock({ size: 26 }),
      }),
      heroMain,
      el('div', { class: 'cd-au-hero-status' }, [
        auStatusPill(auStatusForRow(row.enabled, hasRun)),
        el('div', { class: 'cd-au-hero-toggle' }, [
          el('span', { class: 'cd-au-hero-toggle-lbl' }, 'Enabled'),
          statusToggle,
        ]),
      ]),
    ]);
    view.append(hero);

    // ── Two columns: run history / side rail ──
    const cols = el('div', { class: 'cd-au-cols' });

    // Run history — a header (title + segmented filter) then the rows. The
    // filter chips repaint just the list container. Labels read All / Cron /
    // Webhook / Manual; "cron" maps to scheduled fires.
    const runsBody = el('div', { class: 'cd-au-runs' });
    const filters = el('div', { class: 'cd-au-filters' });
    let runFilter = 'all';
    const matchesFilter = (run: CentraidAutomationRunRecord): boolean => {
      if (runFilter === 'all') return true;
      if (runFilter === 'webhook') return run.triggerOrigin === 'webhook';
      if (runFilter === 'cron') return run.triggerKind === 'scheduled';
      if (runFilter === 'manual') return run.triggerKind === 'manual';
      return true;
    };
    const paintRuns = (): void => {
      const shown = runs.filter(matchesFilter);
      runsBody.replaceChildren(
        ...(shown.length
          ? shown.map(renderAuRunRow)
          : [el('div', { class: 'cd-au-runs-empty' }, 'No runs in this view yet.')]),
      );
      for (const chip of filters.children) {
        const c = chip as HTMLElement;
        if (c.dataset.filter === runFilter) c.dataset.active = 'true';
        else delete c.dataset.active;
      }
    };
    for (const [key, label] of [
      ['all', 'All'],
      ['cron', 'Cron'],
      ['webhook', 'Webhook'],
      ['manual', 'Manual'],
    ] as const) {
      filters.append(
        el(
          'button',
          {
            class: 'cd-au-filter',
            type: 'button',
            'data-filter': key,
            onClick: () => {
              runFilter = key;
              paintRuns();
            },
          },
          label,
        ),
      );
    }
    paintRuns();
    const runsCard = el('div', { class: 'cd-au-runhist' }, [
      el('div', { class: 'cd-au-runhist-h' }, [el('h2', {}, 'Run history'), filters]),
      el('div', { class: 'cd-au-card' }, [runsBody]),
    ]);
    cols.append(el('div', { class: 'cd-au-col-main' }, [runsCard]));

    // ── Side rail: Last 30 days · Behavior + Tools ──
    const now = Date.now();
    const recentRuns = runs.filter((r) => now - r.startedAt <= 30 * 86_400_000);
    const life = automationLifetime(recentRuns);
    const kpi = (icon: IconNameType, label: string, value: string, ok?: boolean): HTMLElement =>
      el('div', { class: 'cd-au-kpi' }, [
        el('div', { class: 'cd-au-kpi-l' }, [
          el('span', {
            class: 'cd-au-kpi-ic',
            'aria-hidden': 'true',
            trustedHtml: Icon[icon]({ size: 13 }),
          }),
          el('span', {}, label),
        ]),
        el('div', { class: 'cd-au-kpi-v', ...(ok ? { 'data-ok': 'true' } : {}) }, value),
      ]);
    const statsCard = el('div', { class: 'cd-au-card cd-au-rail-card' }, [
      el('div', { class: 'cd-au-rail-eyebrow' }, 'Last 30 days'),
      el('div', { class: 'cd-au-kpis' }, [
        kpi('Activity', 'Runs · 30d', String(life.total)),
        kpi('CheckCircle', 'Success', life.successPct === null ? '—' : `${life.successPct}%`, true),
        kpi('Clock', 'Avg duration', life.avg),
        kpi('Coin', 'Cost · 30d', life.cost),
      ]),
    ]);

    const behaviorRow = (icon: IconNameType, label: string, value: string): HTMLElement =>
      el('div', { class: 'cd-au-beh-row' }, [
        el('span', {
          class: 'cd-au-beh-ic',
          'aria-hidden': 'true',
          trustedHtml: Icon[icon]({ size: 14 }),
        }),
        el('span', { class: 'cd-au-beh-k' }, label),
        el('span', { class: 'cd-au-beh-v' }, value),
      ]);
    const model = row.manifest.requires.model ?? row.manifest.costEstimate?.model ?? 'Default';
    const onFailure = row.manifest.onFailure ? `Run "${row.manifest.onFailure}"` : 'Stop';
    const behaviorCard = el('div', { class: 'cd-au-card cd-au-rail-card' }, [
      el('div', { class: 'cd-au-rail-eyebrow' }, 'Behavior'),
      behaviorRow('Settings', 'Model', model),
      behaviorRow('History', 'Run history', fmtRetention(row.manifest.history.keep)),
      behaviorRow('AlertTriangle', 'On failure', onFailure),
    ]);
    // Tools — method-level names (gmail.search, …) when the manifest carries
    // them, else the coarser MCP server list. Sits inside the Behavior card.
    const tools = row.manifest.requires.tools ?? [];
    const toolList = tools.length > 0 ? tools : (row.manifest.requires.mcps ?? []);
    if (toolList.length > 0) {
      behaviorCard.append(
        el('div', { class: 'cd-au-tools-sec' }, [
          el('div', { class: 'cd-au-rail-eyebrow cd-au-rail-eyebrow-sub' }, 'Tools'),
          el(
            'div',
            { class: 'cd-au-tools' },
            toolList.map((t) =>
              el('span', { class: 'cd-au-tool-chip' }, [
                el('span', {
                  class: 'cd-au-tool-ic',
                  'aria-hidden': 'true',
                  trustedHtml: Icon.Plug({ size: 11 }),
                }),
                el('code', {}, t),
              ]),
            ),
          ),
        ]),
      );
    }

    cols.append(el('div', { class: 'cd-au-side' }, [statsCard, behaviorCard]));
    view.append(cols);
    return view;
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
    renderOverviewAutomationRow,
    renderOverviewRunRow,
    collectAutomationRuns,
    loadAutomationTemplates,
  };
}
