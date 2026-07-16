import { useState, type JSX, type ReactNode } from 'react';
import type { IconName } from '@centraid/design-tokens';
import Icon from '../ui/Icon.js';
import Logo from '../ui/Logo.js';
import StatusPill from '../ui/StatusPill.js';
import chrome from './chrome.module.css';
import {
  ArrowRightGlyph,
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

// The shell sidebar — Build new / Search, a Pages section, the live Apps
// list (folding drafts in), a disabled Chats placeholder, and Settings
// pinned to the bottom with a `live` pill. Styled by the shared
// chrome.module.css (one module for the whole window-chrome family,
// co-imported by ShellFrame).

export type SidebarPage =
  | 'home'
  | 'assistant'
  | 'insights'
  | 'discover'
  | 'starred'
  | 'automations'
  | 'approvals'
  | 'gateway'
  | 'settings';

export interface SidebarApp {
  id: string;
  name: string;
  iconKey: IconName;
  color: string;
  status?: 'new' | 'draft' | 'live' | null;
}

/** One row in the sidebar's "Chats" list — a persisted vault-assistant
 *  conversation (mirrors `CentraidConversationSummary`, trimmed to what the
 *  row renders). */
export interface SidebarConversation {
  id: string;
  title: string;
  timeLabel: string;
  /** Pinned threads render in a section above the rest (issue #420). */
  pinned?: boolean;
  /** Archived threads render behind a collapsed group at the bottom. */
  archived?: boolean;
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
  /** The vault assistant's persisted conversations, newest first (the list
   *  endpoint already sorts — see useAssistantConversations). */
  conversations?: SidebarConversation[];
  /** The conversation id of the current route, when it's the assistant
   *  route with one open — highlights that row. */
  activeConversationId?: string;
  /** "+" action on the Chats section header and the empty-state fallback —
   *  starts a fresh (not-yet-created) conversation. */
  onNewChat?: () => void;
  onSelectConversation?: (id: string) => void;
  onDeleteConversation?: (id: string) => void;
  /** Row ••• / right-click menu (Rename + Delete). Wired by App.tsx to the
   *  shared context menu; when present it supersedes the bare delete X. */
  onConversationMenu?: (id: string, anchor: ShellMenuAnchor) => void;
  onSearch?: () => void;
  onAssistant?: () => void;
  onInsights?: () => void;
  onDiscover?: () => void;
  onStarred?: () => void;
  onAutomations?: () => void;
  onApprovals?: () => void;
  /** Count badge next to "Approvals" — omitted (no live count source yet) shows no badge. */
  approvalsCount?: number;
  onGateway?: () => void;
  /** Live heartbeat status pill next to "Gateway" — omitted shows no pill. */
  gatewayStatus?: 'up' | 'down' | 'unknown';
  onAppClick: (id: string) => void;
  onAppContext?: (id: string, anchor: ShellMenuAnchor) => void;
  onSettings: () => void;
  /**
   * A newer build is on disk (main's dist watcher): the version a relaunch
   * would load. Set alongside onRelaunchToUpdate to show the pill above
   * Settings; omitted = no update, no pill.
   */
  updateVersion?: string;
  onRelaunchToUpdate?: () => void;
  /** Open the "What's new" changelog modal. Omitted = the item is hidden. */
  onWhatsNew?: () => void;
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
      className={chrome.sbItem}
      type="button"
      data-active={props.active ? 'true' : undefined}
      data-disabled={props.disabled ? 'true' : undefined}
      data-accent={props.accent ? 'true' : undefined}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.icon}
      <span className={chrome.sbLabel}>{props.label}</span>
      {props.meta ? <span className={chrome.sbMeta}>{props.meta}</span> : null}
      {props.trailing}
    </button>
  );
}

function SbSection({ label, onAction }: { label: string; onAction?: () => void }): JSX.Element {
  return (
    <div className={chrome.sbSection}>
      <span>{label}</span>
      {onAction ? (
        <span className={chrome.sbSectionActions}>
          <button className={chrome.sbSectionBtn} type="button" aria-label="Add" onClick={onAction}>
            <PlusGlyph />
          </button>
        </span>
      ) : null}
    </div>
  );
}

function AppIcon({ app }: { app: SidebarApp }): JSX.Element {
  return (
    <span className={chrome.sbAppIcon} style={{ background: app.color }}>
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
      className={chrome.sbAppRow}
      onContextMenu={(e) => {
        e.preventDefault();
        onAppContext(app.id, { kind: 'point', x: e.clientX, y: e.clientY });
      }}
    >
      {item}
      <button
        className={chrome.rowMore}
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

function ConversationRow({
  conversation,
  active,
  onClick,
  onMenu,
  onDelete,
}: {
  conversation: SidebarConversation;
  active: boolean;
  onClick: () => void;
  onMenu?: (anchor: ShellMenuAnchor) => void;
  onDelete?: () => void;
}): JSX.Element {
  const item = (
    <SbItem
      icon={<SparkleGlyph size={13} />}
      label={conversation.title}
      meta={conversation.timeLabel}
      active={active}
      onClick={onClick}
    />
  );
  // Prefer the ••• menu (Rename + Delete); fall back to the bare delete X when
  // only a delete handler is wired (route unit-test fixtures).
  if (onMenu) {
    return (
      <div
        className={chrome.sbAppRow}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ kind: 'point', x: e.clientX, y: e.clientY });
        }}
      >
        {item}
        <button
          className={chrome.rowMore}
          type="button"
          aria-label="Conversation actions"
          aria-haspopup="menu"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onMenu({ kind: 'rect', rect: e.currentTarget.getBoundingClientRect() });
          }}
        >
          <Icon name="MoreVert" size={14} />
        </button>
      </div>
    );
  }
  if (!onDelete) return item;
  return (
    <div className={chrome.sbAppRow}>
      {item}
      <button
        className={chrome.rowMore}
        type="button"
        aria-label="Delete conversation"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="X" size={12} />
      </button>
    </div>
  );
}

/**
 * The "Chats" list, grouped for scale (issue #420): pinned threads on top, the
 * rest by recency, and archived threads tucked behind a collapsed group at the
 * bottom. Rendering + row menu are unchanged — only the ordering/sectioning is.
 */
function ChatsSection(props: SidebarProps): JSX.Element {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const all = props.conversations ?? [];
  const pinned = all.filter((c) => c.pinned && !c.archived);
  const normal = all.filter((c) => !c.pinned && !c.archived);
  const archived = all.filter((c) => c.archived);
  const activeCount = pinned.length + normal.length;

  const row = (c: SidebarConversation): JSX.Element => (
    <ConversationRow
      key={c.id}
      conversation={c}
      active={c.id === props.activeConversationId}
      onClick={() => props.onSelectConversation?.(c.id)}
      {...(props.onConversationMenu
        ? { onMenu: (anchor: ShellMenuAnchor) => props.onConversationMenu?.(c.id, anchor) }
        : {})}
      onDelete={props.onDeleteConversation ? () => props.onDeleteConversation?.(c.id) : undefined}
    />
  );

  return (
    <>
      <SbSection label={`Chats · ${activeCount}`} onAction={props.onNewChat} />
      {activeCount === 0 ? (
        <SbItem icon={<SparkleGlyph />} label="No conversations yet" disabled />
      ) : (
        <>
          {pinned.length > 0 ? (
            <>
              <div className={chrome.sbSubLabel}>Pinned</div>
              {pinned.map(row)}
              {normal.length > 0 ? <div className={chrome.sbSubLabel}>Recent</div> : null}
            </>
          ) : null}
          {normal.map(row)}
        </>
      )}
      {archived.length > 0 ? (
        <>
          <button
            className={chrome.sbArchivedToggle}
            type="button"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen((o) => !o)}
          >
            <Icon name={archivedOpen ? 'ChevronDown' : 'ChevronRight'} size={13} />
            <span>Archived · {archived.length}</span>
          </button>
          {archivedOpen ? archived.map(row) : null}
        </>
      ) : null}
    </>
  );
}

export default function Sidebar(props: SidebarProps): JSX.Element {
  const appList = [...props.apps, ...props.drafts];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {props.headSlot}

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
      <SbItem
        icon={<Icon name="CheckCircle" size={15} />}
        label="Approvals"
        meta={props.approvalsCount ? String(props.approvalsCount) : undefined}
        active={props.activePage === 'approvals'}
        disabled={!props.onApprovals}
        onClick={props.onApprovals}
      />
      <SbItem
        icon={<Icon name="Cellular" size={15} />}
        label="Gateway"
        active={props.activePage === 'gateway'}
        disabled={!props.onGateway}
        onClick={props.onGateway}
        trailing={
          props.gatewayStatus && props.gatewayStatus !== 'unknown' ? (
            <StatusPill tone={props.gatewayStatus === 'up' ? 'live' : 'down'}>
              {props.gatewayStatus}
            </StatusPill>
          ) : undefined
        }
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

      <ChatsSection {...props} />

      <span style={{ flex: '1', minHeight: '12px' }} />
      {props.onWhatsNew ? (
        <SbItem
          icon={<Icon name="Gift" size={15} />}
          label="What's new"
          onClick={props.onWhatsNew}
        />
      ) : null}
      {props.updateVersion !== undefined && props.onRelaunchToUpdate ? (
        <button className={chrome.sbUpdate} type="button" onClick={props.onRelaunchToUpdate}>
          <Logo size={26} />
          <span className={chrome.sbUpdateBody}>
            <span className={chrome.sbUpdateTitle}>Relaunch to update</span>
            <span className={chrome.sbUpdateVersion}>v{props.updateVersion}</span>
          </span>
          <ArrowRightGlyph />
        </button>
      ) : null}
      <SbItem
        icon={<SettingsGlyph />}
        label="Settings"
        active={props.activePage === 'settings'}
        onClick={props.onSettings}
        trailing={<StatusPill tone="live">live</StatusPill>}
      />
    </div>
  );
}
