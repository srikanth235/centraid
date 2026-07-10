import { useRef, useState, type JSX } from 'react';
import { Icon, KindBadge, StatusPill } from '../ui/index.js';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuStatusKind,
  HomeAppItemDTO,
  HomeAutoItemDTO,
  HomeBridgeProps,
  HomeMenuAnchor,
} from '../screen-contracts.js';
import { INTEGRATION_HUES } from '../format.js';
import styles from './HomeScreen.module.css';
import { cx } from '../ui/cx.js';
import au from '../styles/automation.module.css';
import cardCss from '../ui/AppCard.module.css';
import libCss from '../styles/library.module.css';
import controlsCss from '../styles/controls.module.css';

const STATUS_ICON: Record<AuStatusKind, IconName> = {
  active: 'Power',
  paused: 'Pause',
  draft: 'Pencil',
  running: 'Loader',
  success: 'CheckCircle',
  failed: 'AlertTriangle',
};

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
function RowsGlyph(): JSX.Element {
  return (
    <svg
      width={15}
      height={15}
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

function rectAnchor(e: { currentTarget: HTMLElement }): HomeMenuAnchor {
  const r = e.currentTarget.getBoundingClientRect();
  return {
    kind: 'rect',
    rect: {
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      left: r.left,
      width: r.width,
      height: r.height,
    },
  };
}

function MoreButton({ onOpen }: { onOpen: (a: HomeMenuAnchor) => void }): JSX.Element {
  return (
    <button
      type="button"
      className={cardCss.act}
      aria-label="More actions"
      aria-haspopup="menu"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen(rectAnchor(e));
      }}
    >
      <Icon name="MoreHoriz" size={16} />
    </button>
  );
}

function AppCard({
  a,
  onOpen,
  onEnterDraft,
  onContext,
}: {
  a: HomeAppItemDTO;
  onOpen: (id: string) => void;
  onEnterDraft: (id: string) => void;
  onContext: (id: string, anchor: HomeMenuAnchor) => void;
}): JSX.Element {
  return (
    <div className={cardCss.wrap} data-app-id={a.id} data-starred={String(a.starred)}>
      <button
        type="button"
        className={cx(cardCss.card, cardCss.small)}
        data-testid="app-tile"
        data-kind="app"
        onClick={() => (a.draft ? onEnterDraft(a.id) : onOpen(a.id))}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(a.id, { kind: 'point', x: e.clientX, y: e.clientY });
        }}
      >
        <div className={cardCss.head}>
          <div
            className={cardCss.icon}
            style={{
              background: a.tile.background,
              boxShadow: a.tile.boxShadow,
              color: a.tile.glyphColor,
            }}
          >
            <Icon name={a.iconKey as IconName} size={24} strokeWidth={1.9} />
            {a.tone ? <span className={cardCss.iconDot} data-tone={a.tone} /> : null}
          </div>
          <div className={cardCss.headText}>
            <div className={cardCss.nameRow}>
              <div className={cardCss.name}>{a.name}</div>
              {a.tone ? <StatusPill tone={a.tone}>{a.tone}</StatusPill> : null}
            </div>
            <div className={cardCss.desc}>{a.desc || 'No description yet.'}</div>
          </div>
        </div>
        <div className={cardCss.foot}>
          <KindBadge kind="app">
            <span>App</span>
          </KindBadge>
          <span className={cardCss.footTime}>{a.stamp}</span>
        </div>
      </button>
      <div className={cardCss.actions}>
        <MoreButton onOpen={(anchor) => onContext(a.id, anchor)} />
      </div>
      {a.starred ? (
        <span className={cardCss.starFlag} aria-hidden="true">
          <Icon name="Star" size={14} />
        </span>
      ) : null}
    </div>
  );
}

function AutoCard({
  r,
  onOpen,
  onMenu,
}: {
  r: HomeAutoItemDTO;
  onOpen: (ref: string) => void;
  onMenu: (ref: string, anchor: HomeMenuAnchor) => void;
}): JSX.Element {
  return (
    <div className={cardCss.wrap} data-starred={String(r.starred)}>
      <button
        type="button"
        className={cx(cardCss.card, cardCss.small)}
        data-kind="automation"
        onClick={() => onOpen(r.ref)}
      >
        <div className={cardCss.head}>
          <span className={au.auGlyph} data-hue={r.hue} style={{ width: 52, height: 52 }}>
            <Icon name={r.glyphIcon as IconName} size={24} />
          </span>
          <div className={cardCss.headText}>
            <div className={cardCss.nameRow}>
              <div className={cardCss.name}>{r.name}</div>
            </div>
            <div className={cardCss.desc}>{r.blurb}</div>
          </div>
        </div>
        <div className={styles.appCardMeta}>
          <span className={au.auStatus} data-tone={r.statusKind} role="status">
            <span className={au.auStatusIc} aria-hidden="true">
              <Icon name={STATUS_ICON[r.statusKind]} size={12} />
            </span>
            <span>{r.statusLabel}</span>
          </span>
          <span className={styles.appCardTrig}>
            <span aria-hidden="true">
              <Icon name={r.triggerIcon as IconName} size={12} />
            </span>
            <span>{r.triggerLabel}</span>
          </span>
          {r.integrations.length > 0 ? (
            <div className={au.auOvDots}>
              {r.integrations.slice(0, 4).map((name) => (
                <i
                  key={name}
                  className={au.auOvDot}
                  title={name}
                  style={{ background: `var(--c-${INTEGRATION_HUES[name] ?? 'slate'})` }}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className={cardCss.foot}>
          <KindBadge kind="automation">
            <span>Automation</span>
          </KindBadge>
          <span className={cardCss.footTime} data-ok={r.footOk ? 'true' : undefined}>
            {r.footOk ? (
              <span aria-hidden="true">
                <Icon name="CheckCircle" size={13} />
              </span>
            ) : null}
            <span>{r.footTimeLabel}</span>
          </span>
        </div>
      </button>
      <div className={cardCss.actions}>
        <MoreButton onOpen={(anchor) => onMenu(r.ref, anchor)} />
      </div>
      {r.starred ? (
        <span className={cardCss.starFlag} aria-hidden="true">
          <Icon name="Star" size={14} />
        </span>
      ) : null}
    </div>
  );
}

function EmptyState({ kind }: { kind: 'all' | 'app' | 'automation' }): JSX.Element {
  const [icon, title, sub]: [IconName, string, string] =
    kind === 'automation'
      ? [
          'Bolt',
          'No automations yet',
          'A saved conversation that fires on a trigger. Start from a template, or describe one from scratch.',
        ]
      : kind === 'app'
        ? [
            'Sparkle',
            'No apps yet',
            'Describe an app in the box above — Centraid will build it for you.',
          ]
        : [
            'Sparkle',
            'Nothing here yet',
            'Describe an app or automation in the box above to get started.',
          ];
  return (
    <div className={styles.shelfEmpty}>
      <div className={styles.shelfEmptyIcon}>
        <Icon name={icon} size={20} />
      </div>
      <div className={styles.shelfEmptyTitle}>{title}</div>
      <div className={styles.shelfEmptySub}>{sub}</div>
    </div>
  );
}

/**
 * Home screen, ported to React (issue #325, Phase 3). Composer hero (→ builder)
 * + the unified library shelf (segmented kind filter, Tiles/Rows toggle, one
 * mixed grid of app + automation cards, empty states, "needs attention" badge).
 * The shell derives the card DTOs + owns the context/more menus and the
 * gateway I/O through the callbacks; React renders. Tiles are composed from
 * the shared AppCard module + StatusPill/KindBadge primitives.
 */
export default function HomeScreen({
  suggestions,
  dateLabel,
  appItems,
  automationItems,
  counts,
  attention,
  onBuild,
  onOpenApp,
  onEnterDraft,
  onAppContext,
  onOpenAutomation,
  onAutomationMenu,
  onBrowseTemplates,
}: HomeBridgeProps): JSX.Element {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'all' | 'app' | 'automation'>('all');
  const [layout, setLayout] = useState<'tiles' | 'rows'>('tiles');
  const taRef = useRef<HTMLTextAreaElement>(null);

  const submit = (): void => {
    const v = prompt.trim();
    if (v) onBuild(v);
  };

  const showApps = kind === 'all' || kind === 'app';
  const showAutos = kind === 'all' || kind === 'automation';
  const cardCount = (showApps ? appItems.length : 0) + (showAutos ? automationItems.length : 0);

  const segDefs = [
    { k: 'all' as const, label: 'All', count: counts.all, icon: null },
    { k: 'app' as const, label: 'Apps', count: counts.apps, icon: 'Home' as IconName },
    {
      k: 'automation' as const,
      label: 'Automations',
      count: counts.automations,
      icon: 'Bolt' as IconName,
    },
  ];

  return (
    <div className={styles.day1Scroll}>
      <div className={styles.hero}>
        <div className={styles.heroHead}>
          <div className={styles.heroDate}>{dateLabel}</div>
          <h1>What should we build?</h1>
        </div>
        <div className={styles.heroComposerWrap}>
          <div className={styles.composer}>
            <textarea
              ref={taRef}
              className={styles.composerInput}
              placeholder="Describe an app you want — a habit tracker, a journal, a tiny tool…"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <div className={styles.composerToolbar}>
              <button
                type="button"
                className={cx(controlsCss.iconBtn, styles.composerAttach)}
                title="Attach"
              >
                <Icon name="Plus" size={14} />
              </button>
              <span className={styles.composerSpacer} />
              <span className={styles.composerMode}>
                <span>
                  <Icon name="Sparkle" size={11} />
                </span>
                <span>Build</span>
                <span>
                  <Icon name="ChevronDown" size={9} />
                </span>
              </span>
              <span className={styles.composerKbd}>⌘↵</span>
              <button
                type="button"
                className={styles.composerSend}
                disabled={prompt.trim().length === 0}
                onClick={submit}
              >
                <Icon name="ArrowRight" size={14} />
              </button>
            </div>
          </div>
          <div className={styles.heroSuggestions}>
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className={controlsCss.chip}
                onClick={() => {
                  setPrompt(s);
                  taRef.current?.focus();
                }}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>

      <section className={cx(styles.hsec, styles.homeLib)}>
        <div className={styles.homeLibHead}>
          <div
            className={cx(libCss.discSeg, styles.homeLibSeg)}
            role="tablist"
            aria-label="Filter your library by kind"
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
          {attention > 0 ? (
            <div className={styles.hsecStatus}>
              <span className={styles.hsecStat} data-tone="attention">
                <span aria-hidden="true">
                  <Icon name="AlertTriangle" size={13} />
                </span>
                <span>{`${attention} needs attention`}</span>
              </span>
            </div>
          ) : null}
          <button type="button" className={styles.hsecBrowse} onClick={onBrowseTemplates}>
            <span>Browse templates</span>
            <span aria-hidden="true">
              <Icon name="ChevronRight" size={14} />
            </span>
          </button>
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
        <div className={styles.homeLibBody}>
          {cardCount === 0 ? (
            <EmptyState kind={kind} />
          ) : (
            <div className={cx(styles.appsGrid, styles.appsGridSmall)} data-layout={layout}>
              {showApps
                ? appItems.map((a) => (
                    <AppCard
                      key={a.id}
                      a={a}
                      onOpen={onOpenApp}
                      onEnterDraft={onEnterDraft}
                      onContext={onAppContext}
                    />
                  ))
                : null}
              {showAutos
                ? automationItems.map((r) => (
                    <AutoCard
                      key={r.ref}
                      r={r}
                      onOpen={onOpenAutomation}
                      onMenu={onAutomationMenu}
                    />
                  ))
                : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
