// Automation identity + status DOM primitives shared across the automations
// surfaces (overview, single-automation view, run view) and the templates
// gallery. Pure derivation (hueForId / glyphForId / auStatusForRow) lives in
// the testable ./automation-identity module; these wrap it in DOM.
//
// Identity is DECORATIVE ONLY — it tints the glyph tile, the trigger-hero
// rail, and status dots. Every CTA / active state keeps the single `--accent`
// action colour; the hue must never theme a button or toggle.
//
// `createAutomationsUi(ctx)` returns the DOM builders; the static lookup tables
// (INTEGRATION_HUES, AU_STATUS_META) and the AuStatus union are module-level so
// the templates gallery can reuse INTEGRATION_HUES without a factory.
import { auStatusForRow, glyphForId, hueForId } from './automation-identity.js';
import { fmtTokens, formatDuration, relativeTime, triggersSummary } from './app-format.js';
import type { ShellContext } from './app-shell-context.js';
import type { AutomationFeedEntry } from './app-automations.js';

// Integration name → app-icon hue (the --c-<hue> palette tokens).
export const INTEGRATION_HUES: Readonly<Record<string, string>> = {
  Gmail: 'rose',
  'Google Calendar': 'indigo',
  Slack: 'violet',
  GitHub: 'slate',
  Linear: 'indigo',
  PagerDuty: 'forest',
  Datadog: 'violet',
  Sentry: 'ochre',
  npm: 'ochre',
  Notion: 'slate',
};

// Status is ALWAYS icon + label, never colour alone (WCAG + colourblind).
// `active`/`paused`/`draft` describe an automation; `running`/`success`/
// `failed` describe a single run.
export type AuStatus = 'active' | 'paused' | 'draft' | 'running' | 'success' | 'failed';
const AU_STATUS_META: Record<AuStatus, { label: string; icon: IconNameType; spin?: boolean }> = {
  active: { label: 'Active', icon: 'Power' },
  paused: { label: 'Paused', icon: 'Pause' },
  draft: { label: 'Draft', icon: 'Pencil' },
  running: { label: 'Running', icon: 'Loader', spin: true },
  success: { label: 'Success', icon: 'CheckCircle' },
  failed: { label: 'Failed', icon: 'AlertTriangle' },
};

export interface AutomationsUi {
  autoGlyphTile(id: string, opts?: { size?: number; glyphSize?: number }): HTMLElement;
  auStatusPill(kind: AuStatus, label?: string): HTMLElement;
  triggerBadge(
    triggers: ReadonlyArray<{ kind: string; expr?: string }>,
    opts?: { mono?: boolean },
  ): HTMLElement;
  integrationDots(names: readonly string[]): HTMLElement;
  renderOverviewAutomationRow(
    row: CentraidAutomationRow,
    last: AutomationFeedEntry | undefined,
  ): HTMLElement;
  renderOverviewRunRow(entry: AutomationFeedEntry): HTMLElement;
}

export function createAutomationsUi(ctx: ShellContext): AutomationsUi {
  const { el } = ctx;

  // Hue-tinted app-icon tile at the automation's identity hue + glyph.
  function autoGlyphTile(
    id: string,
    opts: { size?: number; glyphSize?: number } = {},
  ): HTMLElement {
    const size = opts.size ?? 42;
    const glyph = glyphForId(id) as IconNameType;
    return el('span', {
      class: 'cd-au-glyph',
      'data-hue': hueForId(id),
      style: { width: `${size}px`, height: `${size}px` },
      trustedHtml: (Icon[glyph] ?? Icon.Bolt)({
        size: opts.glyphSize ?? Math.round(size * 0.45),
      }),
    });
  }

  function auStatusPill(kind: AuStatus, label?: string): HTMLElement {
    const m = AU_STATUS_META[kind];
    const text = label ?? m.label;
    return el('span', { class: 'cd-au-status', 'data-tone': kind, role: 'status' }, [
      el('span', {
        class: 'cd-au-status-ic',
        'data-spin': m.spin ? 'true' : undefined,
        'aria-hidden': 'true',
        trustedHtml: Icon[m.icon]({ size: 12 }),
      }),
      el('span', { class: 'cd-au-status-tx' }, text),
    ]);
  }

  // Trigger badge — cron-clock / webhook glyph + human schedule label.
  function triggerBadge(
    triggers: ReadonlyArray<{ kind: string; expr?: string }>,
    opts: { mono?: boolean } = {},
  ): HTMLElement {
    const hasCron = triggers.some((t) => t.kind === 'cron');
    const hasWebhook = triggers.some((t) => t.kind === 'webhook');
    const icon: IconNameType = hasWebhook && !hasCron ? 'Webhook' : 'Clock';
    return el(
      'span',
      {
        class: 'cd-au-trigbadge',
        'data-mono': opts.mono ? 'true' : undefined,
      },
      [
        el('span', {
          class: 'cd-au-trigbadge-ic',
          'aria-hidden': 'true',
          trustedHtml: Icon[icon]({ size: 12 }),
        }),
        el('span', { class: 'cd-au-trigbadge-tx' }, triggersSummary(triggers)),
      ],
    );
  }

  // A row of bare integration dots (no labels) — the `mini` IntegrationChip
  // from the spec. Each dot carries the connected app's palette hue + a title
  // so the colour is never the only signal.
  function integrationDots(names: readonly string[]): HTMLElement {
    const wrap = el('div', { class: 'cd-au-ov-dots', 'aria-hidden': names.length === 0 });
    for (const name of names.slice(0, 4)) {
      const hue = INTEGRATION_HUES[name] ?? 'slate';
      const dot = el('i', { class: 'cd-au-ov-dot', title: name });
      dot.style.background = `var(--c-${hue})`;
      wrap.append(dot);
    }
    if (names.length > 4)
      wrap.append(el('span', { class: 'cd-au-ov-dot-more' }, `+${names.length - 4}`));
    return wrap;
  }

  // One automation in the overview list — opens the automation viewer.
  // Grid: glyph · name + trigger badge · integration dots · last-run · status
  // pill + chevron. The identity hue tints the glyph tile + left rail only;
  // the row link itself uses the standard --accent focus/hover.
  function renderOverviewAutomationRow(
    row: CentraidAutomationRow,
    last: AutomationFeedEntry | undefined,
  ): HTMLElement {
    const integrations = row.manifest.requires.mcps ?? [];
    return el(
      'button',
      {
        class: 'cd-au-ov-row',
        type: 'button',
        'data-hue': hueForId(row.id),
        onClick: () => ctx.shell.renderAutomationView(row.ref),
      },
      [
        autoGlyphTile(row.id, { size: 38, glyphSize: 17 }),
        el('span', { class: 'cd-au-ov-body' }, [
          el('span', { class: 'cd-au-ov-name' }, row.name),
          triggerBadge(row.triggers, { mono: true }),
        ]),
        integrationDots([...integrations]),
        el(
          'span',
          { class: 'cd-au-ov-last' },
          last
            ? `Last run ${relativeTime(new Date(last.run.startedAt).toISOString())}`
            : 'No runs yet',
        ),
        el('span', { class: 'cd-au-ov-right' }, [
          auStatusPill(auStatusForRow(row.enabled, !!last)),
          el('span', {
            class: 'cd-au-ov-chev',
            'aria-hidden': 'true',
            trustedHtml: Icon.ChevronRight({ size: 16 }),
          }),
        ]),
      ],
    );
  }

  // One run in the overview's recent-activity stream — opens the thread.
  // success/fail icon · name · summary or error · relative time · trigger ·
  // dur·tokens (mono).
  function renderOverviewRunRow(entry: AutomationFeedEntry): HTMLElement {
    const { run, automationName, automationId } = entry;
    const tokens = (run.totalInputTokens ?? 0) + (run.totalOutputTokens ?? 0);
    const dur = run.endedAt !== undefined ? formatDuration(run.endedAt - run.startedAt) : '—';
    return el(
      'button',
      {
        class: 'cd-au-ov-run',
        type: 'button',
        'data-ok': String(run.ok),
        onClick: () => ctx.shell.renderRunView(automationId, run.runId),
      },
      [
        el('span', {
          class: 'cd-au-ov-run-ic',
          'data-ok': String(run.ok),
          'aria-hidden': 'true',
          trustedHtml: run.ok ? Icon.CheckCircle({ size: 14 }) : Icon.AlertTriangle({ size: 14 }),
        }),
        el('span', { class: 'cd-au-ov-run-body' }, [
          el('span', { class: 'cd-au-ov-run-name' }, automationName),
          el(
            'span',
            { class: 'cd-au-ov-run-sum' },
            run.ok ? (run.summary ?? '—') : (run.error ?? 'Failed'),
          ),
        ]),
        el('span', { class: 'cd-au-ov-run-when' }, [
          el('b', {}, relativeTime(new Date(run.startedAt).toISOString())),
          el(
            'span',
            { class: 'cd-au-ov-run-meta' },
            `${run.triggerOrigin ?? run.triggerKind} · ${dur} · ${fmtTokens(tokens)}`,
          ),
        ]),
      ],
    );
  }

  return {
    autoGlyphTile,
    auStatusPill,
    triggerBadge,
    integrationDots,
    renderOverviewAutomationRow,
    renderOverviewRunRow,
  };
}
