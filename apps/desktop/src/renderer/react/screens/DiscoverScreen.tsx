import { useState, type JSX } from 'react';
import { palette, tileFinish } from '@centraid/design-tokens';
import type { ColorHex, IconName } from '@centraid/design-tokens';
import { Icon, KindBadge } from '../ui/index.js';
import type { DiscoverBridgeProps, DiscoverMenuAnchor, DiscoverTemplate } from '../screen-contracts.js';
import { INTEGRATION_HUES } from '../format.js';
import styles from './DiscoverScreen.module.css';
import { cx } from '../ui/cx.js';
import emptyCss from '../styles/pageEmpty.module.css';
import au from '../styles/automation.module.css';
import libCss from '../styles/library.module.css';
import mainScrollCss from '../styles/mainScroll.module.css';

type Kind = 'all' | 'app' | 'automation';
type Layout = 'tiles' | 'rows';

const isAutomation = (t: DiscoverTemplate): boolean => t.kind === 'automation';

// Rect-based glyphs the path-only Icon set can't express — copied verbatim from
// app-glyphs.ts (GRID_RECTS / ROWS_RECTS) so the React screen and the vanilla
// Home page render the identical marks.
function GridGlyph({ size = 15, sw = 1.75 }: { size?: number; sw?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function RowsGlyph({ size = 15 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.5" />
    </svg>
  );
}

function IntegrationDots({ names }: { names: readonly string[] }): JSX.Element {
  return (
    <div className={cx(au.auOvDots, styles.footDots)} aria-hidden={names.length === 0}>
      {names.slice(0, 4).map((name) => (
        <i
          key={name}
          className={au.auOvDot}
          title={name}
          style={{ background: `var(--c-${INTEGRATION_HUES[name] ?? 'slate'})` }}
        />
      ))}
      {names.length > 4 ? (
        <span className={au.auOvDotMore}>{`+${names.length - 4}`}</span>
      ) : null}
    </div>
  );
}

function TemplateCard({
  t,
  tileVariant,
  onOpenTemplate,
  onOpenAutomationTemplate,
  onTemplateContext,
}: {
  t: DiscoverTemplate;
  tileVariant: DiscoverBridgeProps['tileVariant'];
  onOpenTemplate: (t: DiscoverTemplate) => void;
  onOpenAutomationTemplate: (t: DiscoverTemplate) => void;
  onTemplateContext: (t: DiscoverTemplate, anchor: DiscoverMenuAnchor) => void;
}): JSX.Element {
  const auto = isAutomation(t);
  const color = (palette as Record<string, ColorHex>)[t.colorKey] ?? ('#7C5BD9' as ColorHex);
  const finish = tileFinish(color, tileVariant);
  return (
    <button
      type="button"
      className={styles.card}
      data-kind={auto ? 'automation' : 'app'}
      onClick={() => (auto ? onOpenAutomationTemplate(t) : onOpenTemplate(t))}
      onContextMenu={(e) => {
        e.preventDefault();
        onTemplateContext(t, { kind: 'point', x: e.clientX, y: e.clientY });
      }}
    >
      <div className={styles.cardTop}>
        <div
          className={styles.cardIcon}
          style={{
            background: finish.background,
            boxShadow: finish.boxShadow,
            color: finish.glyphColor,
          }}
        >
          <Icon name={t.iconKey as IconName} size={21} strokeWidth={1.85} />
        </div>
        <div className={styles.cardHead}>
          <div className={styles.cardName}>{t.name}</div>
          <div className={styles.cardDesc}>{t.desc}</div>
        </div>
      </div>
      <div className={styles.cardFoot}>
        <KindBadge kind={auto ? 'automation' : 'app'}>
          <span aria-hidden="true" style={{ display: 'inline-flex' }}>
            {auto ? <Icon name="Bolt" size={12} /> : <GridGlyph size={12} sw={1.85} />}
          </span>
          <span>{auto ? 'Automation' : 'App'}</span>
        </KindBadge>
        {auto ? (
          <>
            <span className={styles.trig}>
              <span aria-hidden="true" style={{ display: 'inline-flex' }}>
                <Icon name={t.triggerKind === 'webhook' ? 'Webhook' : 'Clock'} size={12} />
              </span>
              <span>{t.triggerKind === 'webhook' ? 'Webhook' : 'Cron'}</span>
            </span>
            <IntegrationDots names={[...(t.integrations ?? [])]} />
          </>
        ) : null}
      </div>
    </button>
  );
}

/**
 * Discover — the unified template gallery (issue #325). Renders the `cd-disc-*`
 * markup (styled by the global styles.css) and behavior (kind segmented filter,
 * Tiles/Rows layout toggle, category grouping, click/right-click into the
 * shell's preview + context menu). Rendered by DiscoverRoute.
 */
export default function DiscoverScreen({
  appTemplates,
  automationTemplates,
  tileVariant,
  onOpenTemplate,
  onOpenAutomationTemplate,
  onTemplateContext,
}: DiscoverBridgeProps): JSX.Element {
  const [kind, setKind] = useState<Kind>('all');
  const [layout, setLayout] = useState<Layout>('tiles');

  const all = [...appTemplates, ...automationTemplates];
  const shown = kind === 'all' ? all : kind === 'app' ? appTemplates : automationTemplates;

  // Group by category, apps-first, first-seen order (mirrors the vanilla paint).
  const order: string[] = [];
  const groups = new Map<string, DiscoverTemplate[]>();
  for (const t of shown) {
    const cat = t.category ?? (isAutomation(t) ? 'Automations' : 'Apps');
    let bucket = groups.get(cat);
    if (!bucket) {
      bucket = [];
      groups.set(cat, bucket);
      order.push(cat);
    }
    bucket.push(t);
  }

  const segDefs = [
    { k: 'all' as const, label: 'All', count: all.length, icon: null },
    { k: 'app' as const, label: 'Apps', count: appTemplates.length, icon: 'Home' as IconName },
    {
      k: 'automation' as const,
      label: 'Automations',
      count: automationTemplates.length,
      icon: 'Bolt' as IconName,
    },
  ];

  return (
    <div className={cx(mainScrollCss.mainScroll, styles.scroll)}>
      <div className={styles.wrap}>
        <div className={styles.head}>
          <div className={styles.headText}>
            <div className={styles.eyebrow}>Discover</div>
            <h1>Templates</h1>
            <p>
              Start from a blueprint — an app you open or an automation that runs for you. Clone it,
              then describe your tweaks in the builder.
            </p>
          </div>
        </div>
        <div className={styles.toolbar}>
          <div
            className={cx(libCss.discSeg, styles.toolbarSeg)}
            role="tablist"
            aria-label="Filter templates by kind"
          >
            {segDefs.map((d) => (
              <button
                key={d.k}
                type="button"
                className={libCss.discSegB}
                role="tab"
                aria-selected={d.k === kind}
                data-k={d.k}
                data-active={String(d.k === kind)}
                onClick={() => setKind(d.k)}
              >
                {d.icon ? (
                  <span className={libCss.discSegIc} aria-hidden="true">
                    <Icon name={d.icon} size={13} />
                  </span>
                ) : null}
                <span>{d.label}</span>
                <span className={libCss.discSegN}>{`· ${d.count}`}</span>
              </button>
            ))}
          </div>
          <span className={libCss.hsecSpacer} />
          <div className={libCss.libLayout} role="group" aria-label="Layout">
            <button
              type="button"
              className={libCss.libLayoutBtn}
              title="Tiles"
              aria-label="Tiles"
              aria-pressed={layout === 'tiles'}
              data-layout="tiles"
              onClick={() => setLayout('tiles')}
            >
              <GridGlyph />
            </button>
            <button
              type="button"
              className={libCss.libLayoutBtn}
              title="Rows"
              aria-label="Rows"
              aria-pressed={layout === 'rows'}
              data-layout="rows"
              onClick={() => setLayout('rows')}
            >
              <RowsGlyph />
            </button>
          </div>
        </div>
        <div className={styles.cats}>
          {shown.length === 0 ? (
            <div className={emptyCss.pageEmpty}>
              <div className={emptyCss.pageEmptyIcon} aria-hidden="true">
                <Icon name="Sparkle" size={22} />
              </div>
              <div className={emptyCss.pageEmptyText}>No templates available yet.</div>
            </div>
          ) : (
            order.map((cat) => {
              const bucket = groups.get(cat) ?? [];
              return (
                <section key={cat} className={styles.cat}>
                  <div className={styles.catHead}>
                    <span className={styles.catLabel}>{cat}</span>
                    <span className={styles.catCount}>
                      {String(bucket.length).padStart(2, '0')}
                    </span>
                  </div>
                  <div className={styles.grid} data-layout={layout}>
                    {bucket.map((t) => (
                      <TemplateCard
                        key={`${t.kind ?? 'app'}:${t.id}`}
                        t={t}
                        tileVariant={tileVariant}
                        onOpenTemplate={onOpenTemplate}
                        onOpenAutomationTemplate={onOpenAutomationTemplate}
                        onTemplateContext={onTemplateContext}
                      />
                    ))}
                  </div>
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
