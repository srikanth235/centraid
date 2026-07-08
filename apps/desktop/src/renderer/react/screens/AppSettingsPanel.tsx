import { useEffect, useRef, useState, type CSSProperties, type JSX } from 'react';
import { Icon } from '@centraid/desktop-ui';
import type { AppKnobDTO, AppSettingsBridgeProps, AppSettingsSnapshot } from '../bridge.js';

type Tab = 'appearance' | 'automations' | 'vault' | 'manage';

// The shared icon set lacks palette/wrench glyphs, so the tab strip carries
// small inline SVGs — identical markup to the vanilla popover.
const TAB_GLYPH: Record<Tab, string> = {
  appearance:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20 2.5 2.5 0 0 0 2-4 2.5 2.5 0 0 1 2-4h2a4 4 0 0 0 4-4 10 10 0 0 0-10-8z"/></svg>',
  automations:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
  vault:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l8 4v5c0 5-3.5 9-8 11-4.5-2-8-6-8-11V6z"/></svg>',
  manage:
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4l-5.6 5.6a2 2 0 1 0 2.8 2.8l5.6-5.6a4 4 0 0 1 5.4-5.4l-3 3-2.2-2.2 3-3z"/></svg>',
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'automations', label: 'Automations' },
  { id: 'vault', label: 'Vault' },
  { id: 'manage', label: 'Manage' },
];

function KnobControl({
  knob,
  onCommit,
}: {
  knob: AppKnobDTO;
  onCommit: (key: string, value: string) => void;
}): JSX.Element {
  const [value, setValue] = useState(knob.value);
  const pick = (v: string): void => {
    setValue(v);
    onCommit(knob.key, v);
  };
  if (knob.type === 'swatch') {
    return (
      <div className="cd-swatches" role="radiogroup" aria-label={knob.label}>
        {knob.options.map((o) => (
          <button
            key={o.value}
            type="button"
            className="cd-swatch"
            role="radio"
            aria-checked={o.value === value}
            aria-label={o.label}
            title={o.label}
            data-active={String(o.value === value)}
            style={{ background: o.value }}
            onClick={() => pick(o.value)}
          >
            <Icon name="Check" size={14} strokeWidth={2.5} />
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="seg" role="tablist" aria-label={knob.label}>
      {knob.options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          data-active={String(o.value === value)}
          onClick={() => pick(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ManageItem({
  icon,
  label,
  sub,
  onClick,
}: {
  icon: 'Pencil' | 'Share' | 'Folder';
  label: string;
  sub: string;
  onClick: () => void;
}): JSX.Element {
  return (
    <button type="button" className="cd-app-settings-menu-item" onClick={onClick}>
      <span className="cd-app-settings-menu-icon">
        <Icon name={icon} size={13} />
      </span>
      <span className="cd-app-settings-menu-text">
        <span className="cd-app-settings-menu-label">{label}</span>
        <span className="cd-app-settings-menu-sub">{sub}</span>
      </span>
    </button>
  );
}

/** One standing-order card — run-now, toggle, and a lazy vanilla runs host. */
function OrderCard({
  order,
  onRun,
  onToggle,
  onOpen,
  onMountRuns,
}: {
  order: AppSettingsSnapshot['orders'][number];
  onRun: (ref: string) => void;
  onToggle: (ref: string, enabled: boolean) => void;
  onOpen: (ref: string) => void;
  onMountRuns: (ref: string, host: HTMLElement) => void;
}): JSX.Element {
  const [runsOpen, setRunsOpen] = useState(false);
  const loadedRef = useRef(false);
  const running = order.run.kind === 'running';
  return (
    <article className="cd-app-order" data-enabled={String(order.enabled)} data-automation-id={order.id}>
      <span className="cd-app-order-rail" aria-hidden="true" />
      <div className="cd-app-order-body">
        <div className="cd-app-order-head">
          <button
            type="button"
            className="cd-app-order-name"
            title={`Open ${order.name}`}
            onClick={() => onOpen(order.ref)}
          >
            {order.name}
          </button>
          <span className="cd-app-order-schedule">{order.schedule}</span>
          <button
            type="button"
            className="cd-app-order-run"
            disabled={running}
            onClick={() => onRun(order.ref)}
          >
            {running ? 'Running…' : 'Run now'}
          </button>
        </div>
        <blockquote className="cd-app-order-prompt">{order.prompt}</blockquote>
        <div className="cd-app-order-foot">
          <span className="cd-app-order-handler">{order.appsLabel}</span>
          {order.run.kind === 'done' && (
            <span className="cd-app-order-result" data-ok={String(order.run.ok)}>
              {order.run.label}
            </span>
          )}
          <button
            type="button"
            className="cd-app-order-runs-toggle"
            aria-expanded={runsOpen}
            onClick={() => setRunsOpen((v) => !v)}
          >
            Runs
          </button>
        </div>
        <div
          className="cd-app-order-runs"
          hidden={!runsOpen}
          ref={(node) => {
            if (node && runsOpen && !loadedRef.current) {
              loadedRef.current = true;
              onMountRuns(order.ref, node);
            }
          }}
        />
      </div>
      <label
        className="cd-app-order-toggle"
        aria-label={`${order.enabled ? 'Disable' : 'Enable'} ${order.name}`}
      >
        <input
          type="checkbox"
          checked={order.enabled}
          onChange={(e) => onToggle(order.ref, e.target.checked)}
        />
        <span className="cd-app-order-toggle-track" aria-hidden="true" />
      </label>
    </article>
  );
}

/**
 * App-view settings popover, ported to React (issue #325, Phase 3). The vanilla
 * app-view keeps the iframe host, chrome, and per-app chat; this popover is the
 * React island. The vanilla side owns all gateway I/O and pushes a snapshot on
 * each change; the two deep sub-trees (per-order run history, the vault consent
 * pane) stay vanilla and are injected into host divs this component provides.
 */
export default function AppSettingsPanel(props: AppSettingsBridgeProps): JSX.Element {
  const {
    onReady,
    onClose,
    onKnobCommit,
    onRunOrder,
    onToggleOrder,
    onOpenOrder,
    onOpenAutomations,
    onRename,
    onShare,
    onReveal,
    onDelete,
    onMountRuns,
    onMountVault,
  } = props;
  const [snap, setSnap] = useState<AppSettingsSnapshot | null>(null);
  const [tab, setTab] = useState<Tab>('appearance');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const vaultMounted = useRef(false);

  useEffect(() => {
    onReady((s) => setSnap(s));
  }, [onReady]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!snap)
    return <div className="cd-app-settings-backdrop" role="presentation" onClick={onClose} />;

  const panelStyle = { '--accent-color': snap.accent } as CSSProperties;
  const iconStyle: CSSProperties = {
    background: snap.iconBg,
    color: snap.iconColor,
    ...(snap.iconShadow ? { boxShadow: snap.iconShadow } : {}),
  };

  return (
    <>
      <div className="cd-app-settings-backdrop" role="presentation" onClick={onClose} />
      <div className="cd-app-settings-panel" role="dialog" aria-label="App settings" style={panelStyle}>
        <div className="cd-app-settings-header">
          <span
            className="cd-app-settings-icon"
            style={iconStyle}
            // eslint-disable-next-line react/no-danger -- trusted glyph SVG from the vanilla icon set
            dangerouslySetInnerHTML={{ __html: snap.iconSvg }}
          />
          <div className="cd-app-settings-header-text">
            <div className="cd-app-settings-name">{snap.appName}</div>
            <div className="cd-app-settings-eyebrow">App settings</div>
          </div>
          <button type="button" className="cd-app-settings-close" aria-label="Close" onClick={onClose}>
            <Icon name="X" size={12} />
          </button>
        </div>

        <div className="cd-app-settings-tabs-wrap">
          <div className="cd-app-settings-tabs">
            {TABS.map((t) => {
              if (t.id === 'vault' && !snap.vaultVisible) return null;
              const badge =
                t.id === 'automations'
                  ? snap.automationsBadge
                  : t.id === 'vault'
                    ? snap.vaultBadge
                    : null;
              return (
                <button
                  key={t.id}
                  type="button"
                  className="cd-app-settings-tab"
                  data-active={String(tab === t.id)}
                  onClick={() => setTab(t.id)}
                >
                  <span
                    className="cd-app-settings-tab-glyph"
                    // eslint-disable-next-line react/no-danger -- static inline glyph
                    dangerouslySetInnerHTML={{ __html: TAB_GLYPH[t.id] }}
                  />
                  <span className="cd-app-settings-tab-label">{t.label}</span>
                  {badge != null && badge > 0 && (
                    <span className="cd-app-settings-tab-badge">{badge}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="cd-app-settings-pane" hidden={tab !== 'appearance'}>
          <div className="cd-app-settings-section-host">
            {snap.knobs && snap.knobs.length > 0 ? (
              <div className="cd-app-settings-section">
                <div className="cd-app-settings-section-label">Preferences</div>
                {snap.knobs.map((knob) => (
                  <div key={knob.key} className="cd-app-settings-row">
                    <span className="cd-app-settings-row-label">{knob.label}</span>
                    <KnobControl knob={knob} onCommit={onKnobCommit} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="cd-app-settings-note">No appearance options for this app.</div>
            )}
          </div>
        </div>

        <div className="cd-app-settings-pane" hidden={tab !== 'automations'}>
          <div className="cd-app-settings-section-host">
            {snap.orders.length === 0 ? (
              <div className="cd-app-settings-note">No automations linked to this app yet.</div>
            ) : (
              <div className="cd-app-settings-section cd-app-orders">
                <div className="cd-app-settings-section-label cd-app-orders-label">
                  Standing orders
                </div>
                <div className="cd-app-orders-list">
                  {snap.orders.map((o) => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      onRun={onRunOrder}
                      onToggle={onToggleOrder}
                      onOpen={onOpenOrder}
                      onMountRuns={onMountRuns}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            className="cd-app-settings-pane-link"
            onClick={onOpenAutomations}
          >
            Open Automations →
          </button>
        </div>

        <div className="cd-app-settings-pane" hidden={tab !== 'vault'}>
          <div
            className="cd-app-settings-section-host"
            ref={(node) => {
              if (node && snap.vaultVisible && !vaultMounted.current) {
                vaultMounted.current = true;
                onMountVault(node);
              }
            }}
          />
        </div>

        <div className="cd-app-settings-pane" hidden={tab !== 'manage'}>
          <div className="cd-app-settings-manage">
            <ManageItem
              icon="Pencil"
              label="Rename"
              sub={`Currently · ${snap.appName}`}
              onClick={onRename}
            />
            <ManageItem icon="Share" label="Share…" sub="Link or read-only invite" onClick={onShare} />
            <ManageItem
              icon="Folder"
              label="Reveal in Finder"
              sub="Open the app folder"
              onClick={onReveal}
            />
          </div>
          <div className="cd-app-settings-danger">
            <div className="cd-app-settings-danger-label">Danger zone</div>
            <button
              type="button"
              className="cd-app-settings-menu-item cd-app-settings-danger-item"
              data-danger="true"
              data-armed={deleteArmed ? 'true' : undefined}
              onClick={() => (deleteArmed ? onDelete() : setDeleteArmed(true))}
            >
              <span className="cd-app-settings-menu-icon">
                <Icon name="Trash" size={13} />
              </span>
              <span className="cd-app-settings-menu-text">
                <span className="cd-app-settings-menu-label">Delete app</span>
                <span className="cd-app-settings-menu-sub">
                  Removes the app, its data, and its scheduled automations.
                </span>
              </span>
              <span className="cd-app-settings-confirm-pill" hidden={!deleteArmed}>
                click to confirm
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
