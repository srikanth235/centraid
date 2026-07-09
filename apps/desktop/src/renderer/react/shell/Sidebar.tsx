import type { JSX, ReactNode } from 'react';
import type { IconName } from '@centraid/design-tokens';
import Icon from '../ui/Icon.js';
import {
  HomeGlyph,
  PlusGlyph,
  SearchGlyph,
  SettingsGlyph,
  SparkleGlyph,
  StarGlyph,
} from './glyphs.js';

// The shell's own anchor type — mirrors the ambient `MenuAnchor` in the
// renderer's types.d.ts, redeclared here because the React tsconfig doesn't
// pull in that ambient file. Owned by the shell so the migration doesn't
// depend on the soon-to-be-deleted bridge.ts contract.
export type ShellMenuAnchor =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'rect'; rect: DOMRect };

// React port of the vanilla `buildSidebar` (chrome.ts). Same `.cd-sb-*`
// global classes and section layout — Build new / Search, a Pages section,
// the live Apps list (folding drafts in), a disabled Chats placeholder, and
// Settings pinned to the bottom with a `live` pill. Classes stay global
// strings (co-emitted by the vanilla chrome during the migration).

export type SidebarPage =
  | 'home'
  | 'assistant'
  | 'insights'
  | 'discover'
  | 'starred'
  | 'automations'
  | 'settings';

export interface SidebarApp {
  id: string;
  name: string;
  iconKey: IconName;
  color: string;
  status?: 'new' | 'draft' | 'live' | null;
}

export interface SidebarProps {
  activeId?: string;
  activePage?: SidebarPage;
  apps: SidebarApp[];
  drafts: SidebarApp[];
  /** Profile-switcher head row, rendered above "Build new" with a divider. */
  headSlot?: ReactNode;
  onHome: () => void;
  onNewApp: () => void;
  onNewChat?: () => void;
  onSearch?: () => void;
  onAssistant?: () => void;
  onInsights?: () => void;
  onDiscover?: () => void;
  onStarred?: () => void;
  onAutomations?: () => void;
  onAppClick: (id: string) => void;
  onAppContext?: (id: string, anchor: ShellMenuAnchor) => void;
  onSettings: () => void;
}

function SbItem(props: {
  icon: ReactNode;
  label: string;
  meta?: string;
  active?: boolean;
  disabled?: boolean;
  accent?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <button
      className="cd-sb-item"
      type="button"
      data-active={props.active ? 'true' : undefined}
      data-disabled={props.disabled ? 'true' : undefined}
      data-accent={props.accent ? 'true' : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="cd-sb-label">{props.label}</span>
      {props.meta ? <span className="cd-sb-meta">{props.meta}</span> : null}
      {props.trailing}
    </button>
  );
}

function SbSection({ label, onAction }: { label: string; onAction?: () => void }): JSX.Element {
  return (
    <div className="cd-sb-section">
      <span>{label}</span>
      {onAction ? (
        <span className="cd-sb-section-actions">
          <button
            className="cd-sb-section-btn"
            type="button"
            aria-label="Add"
            onClick={onAction}
          >
            <PlusGlyph />
          </button>
        </span>
      ) : null}
    </div>
  );
}

function AppIcon({ app }: { app: SidebarApp }): JSX.Element {
  return (
    <span className="cd-sb-app-icon" style={{ background: app.color }}>
      <Icon name={app.iconKey} size={11} strokeWidth={1.85} />
    </span>
  );
}

function AppRow({
  app,
  active,
  onClick,
  onAppContext,
}: {
  app: SidebarApp;
  active: boolean;
  onClick: () => void;
  onAppContext?: (id: string, anchor: ShellMenuAnchor) => void;
}): JSX.Element {
  const item = (
    <SbItem icon={<AppIcon app={app} />} label={app.name} active={active} onClick={onClick} />
  );
  if (!onAppContext) return item;
  return (
    <div
      className="cd-sb-app-row"
      onContextMenu={(e) => {
        e.preventDefault();
        onAppContext(app.id, { kind: 'point', x: e.clientX, y: e.clientY });
      }}
    >
      {item}
      <button
        className="cd-card-more cd-sb-more"
        type="button"
        aria-label="App actions"
        aria-haspopup="menu"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const t = e.currentTarget;
          t.dataset.open = 'true';
          onAppContext(app.id, { kind: 'rect', rect: t.getBoundingClientRect() });
        }}
      >
        <Icon name="MoreVert" size={14} />
      </button>
    </div>
  );
}

export default function Sidebar(props: SidebarProps): JSX.Element {
  const appList = [...props.apps, ...props.drafts];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {props.headSlot ? (
        <>
          {props.headSlot}
          <div className="cd-sb-divider" aria-hidden="true" />
        </>
      ) : null}

      <SbItem icon={<PlusGlyph />} label="Build new" meta="⌘N" accent onClick={props.onNewApp} />
      <SbItem
        icon={<SearchGlyph />}
        label="Search"
        meta="⌘K"
        onClick={props.onSearch}
        disabled={!props.onSearch}
      />

      <SbSection label="Pages" />
      <SbItem
        icon={<HomeGlyph />}
        label="Home"
        active={props.activePage === 'home'}
        onClick={props.onHome}
      />
      <SbItem
        icon={<SparkleGlyph />}
        label="Assistant"
        active={props.activePage === 'assistant'}
        disabled={!props.onAssistant}
        onClick={props.onAssistant}
      />
      <SbItem
        icon={<Icon name="Activity" size={15} />}
        label="Insights"
        active={props.activePage === 'insights'}
        disabled={!props.onInsights}
        onClick={props.onInsights}
      />
      <SbItem
        icon={<Icon name="Compass" size={15} />}
        label="Discover"
        active={props.activePage === 'discover'}
        disabled={!props.onDiscover}
        onClick={props.onDiscover}
      />
      <SbItem
        icon={<StarGlyph />}
        label="Starred"
        active={props.activePage === 'starred'}
        disabled={!props.onStarred}
        onClick={props.onStarred}
      />
      <SbItem
        icon={<Icon name="Bolt" size={15} />}
        label="Automations"
        active={props.activePage === 'automations'}
        disabled={!props.onAutomations}
        onClick={props.onAutomations}
      />

      <SbSection label={`Apps · ${appList.length}`} onAction={props.onNewApp} />
      {appList.length > 0 ? (
        appList.map((a) => (
          <AppRow
            key={a.id}
            app={a}
            active={a.id === props.activeId}
            onClick={() => props.onAppClick(a.id)}
            onAppContext={props.onAppContext}
          />
        ))
      ) : (
        <SbItem icon={<SparkleGlyph />} label="No apps yet" disabled />
      )}

      <SbSection label="Chats · 0" onAction={props.onNewChat ?? props.onNewApp} />
      <SbItem icon={<SparkleGlyph />} label="No saved chats yet" disabled />

      <span style={{ flex: '1', minHeight: '12px' }} />
      <SbItem
        icon={<SettingsGlyph />}
        label="Settings"
        active={props.activePage === 'settings'}
        onClick={props.onSettings}
        trailing={
          <span className="cd-status" data-tone="live">
            <span className="cd-status-dot" />
            live
          </span>
        }
      />
    </div>
  );
}
