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
} from './glyphs.js';

// The shell's own anchor type — mirrors the ambient `MenuAnchor` in the
// renderer's types.d.ts, redeclared here because the React tsconfig doesn't
// pull in that ambient file. Owned by the shell so the migration doesn't
// depend on the soon-to-be-deleted bridge.ts contract.
export type ShellMenuAnchor =
  | { kind: 'point'; x: number; y: number }
  | { kind: 'rect'; rect: DOMRect };

// The shell sidebar — Search + New Chat, Automations/Connectors, Pages,
// Operations, History (recent vault-assistant threads + See all), and
// Settings. Styled by chrome.module.css (shared with ShellFrame).

export type SidebarPage =
  | 'home'
  | 'assistant'
  | 'insights'
  | 'discover'
  | 'starred'
  | 'automations'
  | 'connectors'
  | 'approvals'
  | 'gateway'
  | 'backups'
  | 'atlas'
  | 'settings';

/** @deprecated Sidebar no longer lists apps; kept for callers that still type app rows. */
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
  /** @deprecated Apps list is no longer shown in the sidebar. */
  apps?: SidebarApp[];
  /** @deprecated Apps list is no longer shown in the sidebar. */
  drafts?: SidebarApp[];
  /** Profile-switcher head row, rendered above "Build new" with a divider. */
  headSlot?: ReactNode;
  onHome: () => void;
  /** "Build new" — a builder entry point (issue #434, Phase 3). Omitted when
   *  the builder is hidden. */
  onNewApp?: () => void;
  /** The vault assistant's persisted conversations, newest first (the list
   *  endpoint already sorts — see useAssistantConversations). */
  conversations?: SidebarConversation[];
  /** The conversation id of the current route, when it's the assistant
   *  route with one open — highlights that row. */
  activeConversationId?: string;
  /** Top "New Chat" + History empty-state — starts a fresh (not-yet-created)
   *  vault-assistant conversation. */
  onNewChat?: () => void;
  onSelectConversation?: (id: string) => void;
  onDeleteConversation?: (id: string) => void;
  /** Row ••• / right-click menu (Rename + Delete). Wired by App.tsx to the
   *  shared context menu; when present it supersedes the bare delete X. */
  onConversationMenu?: (id: string, anchor: ShellMenuAnchor) => void;
  /** "See all" under History — full conversation list surface. When omitted
   *  the link is hidden and the sidebar shows the full recent list. */
  onSeeAllHistory?: () => void;
  onSearch?: () => void;
  /** @deprecated Prefer onNewChat — Assistant is no longer a separate nav row. */
  onAssistant?: () => void;
  onInsights?: () => void;
  onDiscover?: () => void;
  onAutomations?: () => void;
  onConnectors?: () => void;
  onApprovals?: () => void;
  /** Count badge next to "Approvals" — omitted (no live count source yet) shows no badge. */
  approvalsCount?: number;
  onGateway?: () => void;
  /** Live heartbeat status pill next to "Gateway" — omitted shows no pill. */
  gatewayStatus?: 'up' | 'down' | 'unknown';
  onBackups?: () => void;
  onAtlas?: () => void;
  /** @deprecated Apps list is no longer shown in the sidebar. */
  onAppClick?: (id: string) => void;
  /** @deprecated Apps list is no longer shown in the sidebar. */
  onAppContext?: (id: string, anchor: ShellMenuAnchor) => void;
  onSettings: () => void;
  /**
   * A newer build is on disk (main's dist watcher): the version a relaunch
   * would load. Set alongside onRelaunchToUpdate to show the pill above
   * Settings; omitted = no update, no pill.
   */
  updateVersion?: string;
  onRelaunchToUpdate?: () => void;
  /** Pill label override (download in flight vs ready to install — #501). */
  updatePillTitle?: string;
  /** When false, pill is shown but disabled (download still running). */
  updateReadyToInstall?: boolean;
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

/** Cap recent rows in the sidebar History section; "See all" opens the rest. */
const HISTORY_SIDEBAR_CAP = 6;

/**
 * History list (ex-"Chats"): pinned first, then recent, with optional
 * archived group. Caps the non-archived list when `onSeeAllHistory` is set.
 */
function HistorySection(props: SidebarProps): JSX.Element {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const all = props.conversations ?? [];
  const pinned = all.filter((c) => c.pinned && !c.archived);
  const normal = all.filter((c) => !c.pinned && !c.archived);
  const archived = all.filter((c) => c.archived);
  const activeCount = pinned.length + normal.length;
  const effectiveCap = expanded ? Number.POSITIVE_INFINITY : HISTORY_SIDEBAR_CAP;
  const pinnedShow = pinned.slice(0, effectiveCap);
  const remaining = Math.max(0, effectiveCap - pinnedShow.length);
  const normalShow = normal.slice(0, remaining);

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
      <SbSection label="History" />
      {activeCount === 0 ? (
        <SbItem
          icon={<SparkleGlyph />}
          label="No chats yet"
          disabled={!props.onNewChat}
          onClick={props.onNewChat}
        />
      ) : (
        <>
          {pinnedShow.length > 0 ? (
            <>
              <div className={chrome.sbSubLabel}>Pinned</div>
              {pinnedShow.map(row)}
              {normalShow.length > 0 ? <div className={chrome.sbSubLabel}>Recent</div> : null}
            </>
          ) : null}
          {normalShow.map(row)}
        </>
      )}
      {!expanded && activeCount > HISTORY_SIDEBAR_CAP ? (
        <button
          className={chrome.sbSeeAll}
          type="button"
          onClick={() => {
            if (props.onSeeAllHistory) props.onSeeAllHistory();
            else setExpanded(true);
          }}
        >
          See all · {activeCount}
        </button>
      ) : null}
      {expanded && activeCount > HISTORY_SIDEBAR_CAP ? (
        <button className={chrome.sbSeeAll} type="button" onClick={() => setExpanded(false)}>
          Show less
        </button>
      ) : null}
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {props.headSlot}

      {/* Primary actions — Grok-style: Search + New Chat first. */}
      <SbItem
        icon={<SearchGlyph />}
        label="Search"
        meta="⌘K"
        onClick={props.onSearch}
        disabled={!props.onSearch}
      />
      <SbItem
        icon={<Icon name="Plus" size={15} />}
        label="New Chat"
        active={props.activePage === 'assistant' && !props.activeConversationId}
        disabled={!props.onNewChat && !props.onAssistant}
        onClick={props.onNewChat ?? props.onAssistant}
        accent
      />
      {props.onNewApp ? (
        <SbItem icon={<PlusGlyph />} label="Build new" meta="⌘N" onClick={props.onNewApp} />
      ) : null}

      {/* Automations + Connectors sit above Pages for quick access. */}
      <SbItem
        icon={<Icon name="Bolt" size={15} />}
        label="Automations"
        active={props.activePage === 'automations'}
        disabled={!props.onAutomations}
        onClick={props.onAutomations}
      />
      <SbItem
        icon={<Icon name="Plug" size={15} />}
        label="Connectors"
        active={props.activePage === 'connectors'}
        disabled={!props.onConnectors}
        onClick={props.onConnectors}
      />

      <SbSection label="Pages" />
      <SbItem
        icon={<HomeGlyph />}
        label="Home"
        active={props.activePage === 'home'}
        onClick={props.onHome}
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
        icon={<Icon name="CheckCircle" size={15} />}
        label="Approvals"
        meta={props.approvalsCount ? String(props.approvalsCount) : undefined}
        active={props.activePage === 'approvals'}
        disabled={!props.onApprovals}
        onClick={props.onApprovals}
      />
      <SbSection label="Operations" />
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
      <SbItem
        icon={<Icon name="Save" size={15} />}
        label="Backups"
        active={props.activePage === 'backups'}
        disabled={!props.onBackups}
        onClick={props.onBackups}
      />
      <SbItem
        icon={<Icon name="Globe" size={15} />}
        label="Vault Atlas"
        active={props.activePage === 'atlas'}
        disabled={!props.onAtlas}
        onClick={props.onAtlas}
      />

      <HistorySection {...props} />

      <span style={{ flex: '1', minHeight: '12px' }} />
      {props.onWhatsNew ? (
        <SbItem
          icon={<Icon name="Gift" size={15} />}
          label="What's new"
          onClick={props.onWhatsNew}
        />
      ) : null}
      {props.updateVersion !== undefined && props.onRelaunchToUpdate ? (
        <button
          className={chrome.sbUpdate}
          type="button"
          onClick={props.onRelaunchToUpdate}
          disabled={props.updateReadyToInstall === false}
        >
          <Logo size={26} />
          <span className={chrome.sbUpdateBody}>
            <span className={chrome.sbUpdateTitle}>
              {props.updatePillTitle ?? 'Relaunch to update'}
            </span>
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
