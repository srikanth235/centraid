import { useRef, useState, type JSX } from 'react';
import { Icon } from '@centraid/desktop-ui';
import type { IconName } from '@centraid/design-tokens';
import type {
  AuStatusKind,
  HomeAppItemDTO,
  HomeAutoItemDTO,
  HomeBridgeProps,
  HomeMenuAnchor,
} from '../bridge.js';
import { INTEGRATION_HUES } from '../format.js';

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
      className="cd-card-act cd-card-act-more"
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
    <div className="cd-app-card-wrap" data-app-id={a.id} data-starred={String(a.starred)}>
      <button
        type="button"
        className="cd-app-card cd-app-card--small"
        data-testid="app-tile"
        data-kind="app"
        onClick={() => (a.draft ? onEnterDraft(a.id) : onOpen(a.id))}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(a.id, { kind: 'point', x: e.clientX, y: e.clientY });
        }}
      >
        <div className="cd-app-card-head">
          <div
            className="cd-app-card-icon"
            style={{
              background: a.tile.background,
              boxShadow: a.tile.boxShadow,
              color: a.tile.glyphColor,
            }}
          >
            <Icon name={a.iconKey as IconName} size={24} strokeWidth={1.9} />
            {a.tone ? <span className="cd-app-card-icon-dot" data-tone={a.tone} /> : null}
          </div>
          <div className="cd-app-card-head-text">
            <div className="cd-app-card-name-row">
              <div className="cd-app-card-name">{a.name}</div>
              {a.tone ? (
                <span className="cd-status" data-tone={a.tone}>
                  <span className="cd-status-dot" />
                  {a.tone}
                </span>
              ) : null}
            </div>
            <div className="cd-app-card-desc">{a.desc || 'No description yet.'}</div>
          </div>
        </div>
        <div className="cd-app-card-foot">
          <span className="cd-disc-badge" data-kind="app">
            <span>App</span>
          </span>
          <span className="cd-app-card-foot-time">{a.stamp}</span>
        </div>
      </button>
      <div className="cd-card-actions">
        <MoreButton onOpen={(anchor) => onContext(a.id, anchor)} />
      </div>
      {a.starred ? (
        <span className="cd-card-star-flag" aria-hidden="true">
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
    <div className="cd-app-card-wrap" data-starred={String(r.starred)}>
      <button
        type="button"
        className="cd-app-card cd-app-card--small"
        data-kind="automation"
        onClick={() => onOpen(r.ref)}
      >
        <div className="cd-app-card-head">
          <span className="cd-au-glyph" data-hue={r.hue} style={{ width: 52, height: 52 }}>
            <Icon name={r.glyphIcon as IconName} size={24} />
          </span>
          <div className="cd-app-card-head-text">
            <div className="cd-app-card-name-row">
              <div className="cd-app-card-name">{r.name}</div>
            </div>
            <div className="cd-app-card-desc">{r.blurb}</div>
          </div>
        </div>
        <div className="cd-app-card-meta">
          <span className="cd-au-status" data-tone={r.statusKind} role="status">
            <span className="cd-au-status-ic" aria-hidden="true">
              <Icon name={STATUS_ICON[r.statusKind]} size={12} />
            </span>
            <span className="cd-au-status-tx">{r.statusLabel}</span>
          </span>
          <span className="cd-app-card-trig">
            <span aria-hidden="true">
              <Icon name={r.triggerIcon as IconName} size={12} />
            </span>
            <span>{r.triggerLabel}</span>
          </span>
          {r.integrations.length > 0 ? (
            <div className="cd-au-ov-dots">
              {r.integrations.slice(0, 4).map((name) => (
                <i
                  key={name}
                  className="cd-au-ov-dot"
                  title={name}
                  style={{ background: `var(--c-${INTEGRATION_HUES[name] ?? 'slate'})` }}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div className="cd-app-card-foot">
          <span className="cd-disc-badge" data-kind="automation">
            <span>Automation</span>
          </span>
          <span className="cd-app-card-foot-time" data-ok={r.footOk ? 'true' : undefined}>
            {r.footOk ? (
              <span aria-hidden="true">
                <Icon name="CheckCircle" size={13} />
              </span>
            ) : null}
            <span>{r.footTimeLabel}</span>
          </span>
        </div>
      </button>
      <div className="cd-card-actions">
        <MoreButton onOpen={(anchor) => onMenu(r.ref, anchor)} />
      </div>
      {r.starred ? (
        <span className="cd-card-star-flag" aria-hidden="true">
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
    <div className="cd-shelf-empty">
      <div className="cd-shelf-empty-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="cd-shelf-empty-title">{title}</div>
      <div className="cd-shelf-empty-sub">{sub}</div>
    </div>
  );
}

/**
 * Home screen, ported to React (issue #325, Phase 3). Composer hero (→ builder)
 * + the unified library shelf (segmented kind filter, Tiles/Rows toggle, one
 * mixed grid of app + automation cards, empty states, "needs attention" badge).
 * The vanilla shell derives the card DTOs + owns the context/more menus and the
 * gateway I/O through the callbacks; React renders. Same `cd-*` classes.
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
    <div className="cd-day1-scroll">
      <div className="cd-hero">
        <div className="cd-hero-head">
          <div className="cd-hero-date">{dateLabel}</div>
          <h1>What should we build?</h1>
        </div>
        <div className="cd-hero-composer-wrap">
          <div className="cd-composer">
            <textarea
              ref={taRef}
              className="cd-composer-input"
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
            <div className="cd-composer-toolbar">
              <button type="button" className="cd-icon-btn cd-composer-attach" title="Attach">
                <Icon name="Plus" size={14} />
              </button>
              <span className="cd-composer-spacer" />
              <span className="cd-composer-mode">
                <span>
                  <Icon name="Sparkle" size={11} />
                </span>
                <span>Build</span>
                <span>
                  <Icon name="ChevronDown" size={9} />
                </span>
              </span>
              <span className="cd-kbd cd-composer-kbd">⌘↵</span>
              <button
                type="button"
                className="cd-composer-send"
                disabled={prompt.trim().length === 0}
                onClick={submit}
              >
                <Icon name="ArrowRight" size={14} />
              </button>
            </div>
          </div>
          <div className="cd-hero-suggestions">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="cd-chip"
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

      <section className="cd-hsec cd-home-lib">
        <div className="cd-home-lib-head">
          <div className="cd-disc-seg" role="tablist" aria-label="Filter your library by kind">
            {segDefs.map((d) => (
              <button
                key={d.k}
                type="button"
                className="cd-disc-seg-b"
                role="tab"
                aria-selected={d.k === kind}
                data-k={d.k}
                data-active={String(d.k === kind)}
                onClick={() => setKind(d.k)}
              >
                {d.icon ? (
                  <span className="cd-disc-seg-ic" aria-hidden="true">
                    <Icon name={d.icon} size={13} />
                  </span>
                ) : null}
                <span>{d.label}</span>
                <span className="cd-disc-seg-n">{`· ${d.count}`}</span>
              </button>
            ))}
          </div>
          <span className="cd-hsec-spacer" />
          {attention > 0 ? (
            <div className="cd-hsec-status">
              <span className="cd-hsec-stat" data-tone="attention">
                <span aria-hidden="true">
                  <Icon name="AlertTriangle" size={13} />
                </span>
                <span>{`${attention} needs attention`}</span>
              </span>
            </div>
          ) : null}
          <button type="button" className="cd-hsec-browse" onClick={onBrowseTemplates}>
            <span>Browse templates</span>
            <span aria-hidden="true">
              <Icon name="ChevronRight" size={14} />
            </span>
          </button>
          <div className="cd-lib-layout" role="group" aria-label="Layout">
            <button
              type="button"
              className="cd-lib-layout-btn"
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
              className="cd-lib-layout-btn"
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
        <div className="cd-home-lib-body">
          {cardCount === 0 ? (
            <EmptyState kind={kind} />
          ) : (
            <div className="cd-apps-grid cd-apps-grid--small" data-layout={layout}>
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
