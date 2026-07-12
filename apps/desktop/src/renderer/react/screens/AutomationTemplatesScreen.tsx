import { useMemo, useState, type CSSProperties, type JSX } from 'react';
import type { IconName } from '@centraid/design-tokens';
import { Icon } from '../ui/index.js';
import type { AutomationTemplatesBridgeProps, DiscoverTemplate } from '../screen-contracts.js';
import { INTEGRATION_HUES } from '../format.js';
import styles from './AutomationTemplatesScreen.module.css';
import au from '../styles/automation.module.css';
import { cx } from '../ui/cx.js';

type Trig = 'all' | 'cron' | 'webhook' | 'data' | 'condition';

// Trigger-kind → icon/label/hue, matching the labels automationsData.ts'
// deriveAutomationHero (kindEyebrow/run trig) uses for the same four kinds —
// data and condition triggers reuse the Clock glyph there too (only webhook
// gets its own icon), so the card badge and the segmented filter stay honest
// without inventing a new mark. `hue` borrows the identity-hue palette from
// `styles/automation.module.css`'s `[data-hue]` map — templates aren't
// automation instances yet (no `hueForId`), so the accent is keyed off
// trigger kind instead, kept fixed and decorative only (never gates state).
const TRIGGER_KIND_META: Record<
  'cron' | 'webhook' | 'data' | 'condition',
  { icon: IconName; label: string; hue: string }
> = {
  cron: { icon: 'Clock', label: 'Cron', hue: 'indigo' },
  webhook: { icon: 'Webhook', label: 'Webhook', hue: 'teal' },
  data: { icon: 'Clock', label: 'Data', hue: 'violet' },
  condition: { icon: 'Clock', label: 'Condition', hue: 'ochre' },
};

function IntegrationChips({ integrations }: { integrations: readonly string[] }): JSX.Element {
  return (
    <div className={au.auChips}>
      {integrations.map((name) => (
        <span key={name} className={au.auChip}>
          <i
            className={au.auChipDot}
            aria-hidden="true"
            style={{ background: `var(--c-${INTEGRATION_HUES[name] ?? 'slate'})` }}
          />
          {name}
        </span>
      ))}
    </div>
  );
}

function TemplateCard({
  t,
  onOpen,
}: {
  t: DiscoverTemplate;
  onOpen: (t: DiscoverTemplate) => void;
}): JSX.Element {
  const meta = TRIGGER_KIND_META[t.triggerKind ?? 'cron'];
  return (
    <button
      type="button"
      className={styles.card}
      style={{ '--tk-hue': `var(--c-${meta.hue})` } as CSSProperties}
      onClick={() => onOpen(t)}
    >
      <span className={styles.use}>
        <span>Use template</span>
        <Icon name="ArrowRight" size={13} />
      </span>
      <span className={styles.top}>
        <span className={styles.emoji}>{t.emoji ?? '⚙️'}</span>
        <span className={styles.name}>{t.name}</span>
      </span>
      <span className={styles.desc}>{t.desc}</span>
      <span className={styles.foot}>
        <span className={styles.trig}>
          <span className={styles.trigIcon} aria-hidden="true">
            <Icon name={meta.icon} size={13} />
          </span>
          {t.triggerLabel ?? ''}
        </span>
        <IntegrationChips integrations={t.integrations ?? []} />
      </span>
    </button>
  );
}

/**
 * Automation templates gallery, ported to React (issue #325, Phase 3). Live
 * search + trigger segmented filter + integration filter chips over the
 * category-grouped card grid. Cards open the (still-vanilla) preview drawer via
 * `onPreview`; the empty-state "Start from scratch" routes through
 * `onStartFromScratch`. Emits the same `cd-au-tpl-*` classes.
 */
export default function AutomationTemplatesScreen({
  templates,
  subtitle,
  onPreview,
  onStartFromScratch,
}: AutomationTemplatesBridgeProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [trig, setTrig] = useState<Trig>('all');
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());

  const allIntegrations = useMemo(() => {
    const out: string[] = [];
    for (const t of templates) {
      for (const i of t.integrations ?? []) {
        if (!out.includes(i)) out.push(i);
      }
    }
    return out;
  }, [templates]);

  const q = query.trim().toLowerCase();
  const shown = templates.filter((t) => {
    if (trig !== 'all' && (t.triggerKind ?? 'cron') !== trig) return false;
    if (active.size > 0) {
      const ints = t.integrations ?? [];
      for (const want of active) {
        if (!ints.includes(want)) return false;
      }
    }
    if (q) {
      const hay =
        `${t.name} ${t.desc} ${t.category ?? ''} ${(t.integrations ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const cats: string[] = [];
  for (const t of shown) {
    const c = t.category ?? 'Other';
    if (!cats.includes(c)) cats.push(c);
  }

  const toggleIntegration = (name: string): void => {
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const clearFilters = (): void => {
    setQuery('');
    setTrig('all');
    setActive(new Set());
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.titleRow}>
          <span className={styles.titleIcon} aria-hidden="true">
            <Icon name="Bolt" size={16} strokeWidth={2} />
          </span>
          <h1 className={styles.title}>Templates</h1>
        </div>
        {subtitle ? <p className={styles.sub}>{subtitle}</p> : null}
      </div>

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <span className={styles.searchIc} aria-hidden="true">
            <Icon name="Search" size={14} />
          </span>
          <input
            className={styles.searchIn}
            type="search"
            placeholder="Search templates…"
            aria-label="Search templates"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className={styles.seg} role="tablist" aria-label="Filter by trigger">
          {(['all', 'cron', 'webhook', 'data', 'condition'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={styles.segB}
              role="tab"
              aria-selected={k === trig}
              data-k={k}
              data-active={k === trig ? 'true' : undefined}
              onClick={() => setTrig(k)}
            >
              {k === 'all' ? 'All' : TRIGGER_KIND_META[k].label}
            </button>
          ))}
        </div>
      </div>

      {allIntegrations.length > 0 ? (
        <div className={styles.fltrChips}>
          {allIntegrations.map((name) => {
            const on = active.has(name);
            return (
              <button
                key={name}
                type="button"
                className={styles.fltrChip}
                aria-pressed={on}
                data-active={on ? 'true' : undefined}
                onClick={() => toggleIntegration(name)}
              >
                <i
                  className={au.auChipDot}
                  aria-hidden="true"
                  style={{ background: `var(--c-${INTEGRATION_HUES[name] ?? 'slate'})` }}
                />
                {name}
              </button>
            );
          })}
        </div>
      ) : null}

      <div>
        {shown.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon} aria-hidden="true">
              <Icon name="Filter" size={22} />
            </div>
            <div className={styles.emptyTitle}>No templates match</div>
            <div className={styles.emptyText}>Try a different search or clear the filters.</div>
            <div className={styles.emptyActions}>
              <button type="button" className={cx(au.auBtn, au.auBtnGhost)} onClick={clearFilters}>
                <Icon name="X" size={14} />
                <span>Clear filters</span>
              </button>
              <button
                type="button"
                className={cx(au.auBtn, au.auBtnPrimary)}
                onClick={onStartFromScratch}
              >
                <Icon name="Sparkle" size={14} />
                <span>Start from scratch</span>
              </button>
            </div>
          </div>
        ) : (
          cats.map((cat) => (
            <section key={cat} className={styles.cat}>
              <div className={styles.catLabel}>{cat}</div>
              <div className={styles.grid}>
                {shown
                  .filter((t) => (t.category ?? 'Other') === cat)
                  .map((t) => (
                    <TemplateCard key={`${t.kind ?? 'auto'}:${t.id}`} t={t} onOpen={onPreview} />
                  ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
