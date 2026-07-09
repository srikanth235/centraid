import { useMemo, useState, type JSX } from 'react';
import { Icon } from '../ui/index.js';
import type { AutomationTemplatesBridgeProps, DiscoverTemplate } from '../bridge.js';
import { INTEGRATION_HUES } from '../format.js';
import styles from './AutomationTemplatesScreen.module.css';
import { cx } from '../ui/cx.js';

type Trig = 'all' | 'cron' | 'webhook';

function IntegrationChips({ integrations }: { integrations: readonly string[] }): JSX.Element {
  return (
    <div className="cd-au-chips">
      {integrations.map((name) => (
        <span key={name} className="cd-au-chip">
          <i
            className="cd-au-chip-dot"
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
  return (
    <button type="button" className={styles.card} onClick={() => onOpen(t)}>
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
            <Icon name={t.triggerKind === 'webhook' ? 'Webhook' : 'Clock'} size={13} />
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
          {(['all', 'cron', 'webhook'] as const).map((k) => (
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
              {k === 'all' ? 'All' : k === 'cron' ? 'Cron' : 'Webhook'}
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
                  className="cd-au-chip-dot"
                  aria-hidden="true"
                  style={{ background: `var(--c-${INTEGRATION_HUES[name] ?? 'slate'})` }}
                />
                {name}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className={styles.cats}>
        {shown.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon} aria-hidden="true">
              <Icon name="Filter" size={22} />
            </div>
            <div className={styles.emptyTitle}>No templates match</div>
            <div className={styles.emptyText}>Try a different search or clear the filters.</div>
            <div className={styles.emptyActions}>
              <button type="button" className="cd-au-btn cd-au-btn-ghost" onClick={clearFilters}>
                <Icon name="X" size={14} />
                <span>Clear filters</span>
              </button>
              <button
                type="button"
                className="cd-au-btn cd-au-btn-primary"
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
