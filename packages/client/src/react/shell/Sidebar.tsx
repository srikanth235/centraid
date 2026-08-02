import { useState } from "react";
import type { JSX, ReactNode } from "react";
// governance: allow-repo-hygiene file-size-limit (#608) cohesive navigation component owns desktop, mobile, and compact variants over one item model

import { identityColor, identityInitials } from "@centraid/design";

import Icon from "../ui/Icon.js";
import Logo from "../ui/Logo.js";
import { openMenu } from "./contextMenu.js";
import { ArrowRightGlyph, PlusGlyph, SparkleGlyph } from "./glyphs.js";
import { buildNavSections } from "./navModel.js";
import type { NavItem } from "./navModel.js";

import chrome from "./chrome.module.css";

// The shell's own anchor type — mirrors the ambient `MenuAnchor` in the
// renderer's types.d.ts, redeclared here because the React tsconfig doesn't
// pull in that ambient file. Owned by the shell so the migration doesn't
// depend on the soon-to-be-deleted bridge.ts contract.
export type ShellMenuAnchor =
  | { kind: "point"; x: number; y: number }
  | { kind: "rect"; rect: DOMRect };

// The shell sidebar, in three zones (issue #667):
//
//   head    — the vault identity row (headSlot), supplied by App.
//   scroll  — the nav sections from navModel, then Recents. One scroll region,
//             so a short window clips nothing and Recents grows into whatever
//             height is left over.
//   foot    — pinned: gateway alarm (only when down), update pill, account.
//
// Order and grouping live in navModel.ts; this file owns how a row LOOKS and
// the two lists it cannot express as flat data (conversation history, with its
// pinned/archived grouping and per-row menus, and the foot).
//
// Styled by chrome.module.css, shared with ShellFrame — including the compact
// breakpoint, where the whole column becomes an overlay drawer.

export type SidebarPage =
  | "home"
  | "assistant"
  | "insights"
  | "discover"
  | "starred"
  | "automations"
  | "connectors"
  | "approvals"
  | "gateway"
  | "household"
  | "storage"
  | "atlas"
  | "settings";

/** One row in the sidebar's "Recents" list — a persisted vault-assistant
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
  /** The vault this conversation reads, when it is NOT the member's own
   *  (issue #599). A conversation is pinned to one vault for life, so the row
   *  says which — but only when that is news; labelling every row with the
   *  member's own vault would be noise. */
  scopeLabel?: string;
}

export interface SidebarProps {
  activeId?: string;
  activePage?: SidebarPage;
  /** Vault-identity head row, rendered above the actions with a divider. */
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
  /** Top "New Chat" + Recents empty-state — starts a fresh (not-yet-created)
   *  vault-assistant conversation. */
  onNewChat?: () => void;
  onSelectConversation?: (id: string) => void;
  onDeleteConversation?: (id: string) => void;
  /** Row ••• / right-click menu (Rename + Delete). Wired by App.tsx to the
   *  shared context menu; when present it supersedes the bare delete X. */
  onConversationMenu?: (id: string, anchor: ShellMenuAnchor) => void;
  /** "See all" under Recents — full conversation list surface. When omitted
   *  the link is hidden and the sidebar shows the full recent list. */
  onSeeAllHistory?: () => void;
  onSearch?: () => void;
  /** Labelled "Analytics" in the column (#667). */
  onInsights?: () => void;
  onAutomations?: () => void;
  onConnectors?: () => void;
  /** Labelled "Notifications" in the column. */
  onApprovals?: () => void;
  /** Count badge next to Notifications — decisions only. */
  approvalsCount?: number;
  /** Notices are informational and use a dot instead of inflating the badge. */
  notificationsHasUnreadNotices?: boolean;
  /** Gateway has no standing nav row (#667): a healthy daemon is the 99% case
   *  and earns no pixels. Reached from the foot alarm below, the ⌘K palette,
   *  and Analytics. */
  onGateway?: () => void;
  /** Live heartbeat. Only "down" renders anything — the foot alarm. */
  gatewayStatus?: "up" | "down" | "unknown";
  /** People, devices and vaults (issue #599) — labelled "Devices" (#667). */
  onHousehold?: () => void;
  /** The ontology census — labelled "Data" in the column (#667). */
  onAtlas?: () => void;
  onSettings: () => void;
  /** Open the phone-pairing modal. Omitted = the menu offers no pairing. */
  onPairDevice?: () => void;
  /** The signed-in person, shown in the sidebar foot in place of a bare
   *  "Settings" row. Falsy while the roster is still loading. */
  accountName?: string;
  accountColor?: string;
  /** Drop this device's pairing and return to onboarding. Omitted = the menu
   *  offers no log-out (nothing local to forget). */
  onLogOut?: () => void;
  /**
   * A newer build is on disk (main's dist watcher): the version a relaunch
   * would load. Set alongside onRelaunchToUpdate to show the pill above
   * the account row; omitted = no update, no pill.
   */
  updateVersion?: string;
  onRelaunchToUpdate?: () => void;
  /** Pill label override (download in flight vs ready to install — #501). */
  updatePillTitle?: string;
  /** When false, pill is shown but disabled (download still running). */
  updateReadyToInstall?: boolean;
  /** Open the "What's new" changelog modal. Lives in the account menu (#667),
   *  not a standing row. Omitted = the menu item is hidden. */
  onWhatsNew?: () => void;
}

/**
 * The sidebar foot is the account row: who you are, not what you can
 * configure. Settings, pairing, and "What's new" moved into its menu because
 * each is something you do a handful of times, while your own name is the
 * thing that should be standing there.
 */
function AccountRow(props: SidebarProps): JSX.Element {
  const name = props.accountName?.trim() || "You";
  return (
    <button
      type="button"
      className={chrome.sbAccount}
      aria-haspopup="menu"
      aria-label={`${name}. Account menu.`}
      onClick={(event) => {
        // Anchor to the SIDEBAR, inset by a hair, not to the button: the menu
        // should read as this column opening upward, so it lines up with the
        // rail's edges rather than floating at some content width inside it.
        const row = event.currentTarget.getBoundingClientRect();
        const column =
          event.currentTarget.closest(`.${chrome.sbColumn}`) ?? null;
        const bounds = column?.getBoundingClientRect() ?? row;
        const gap = 8;
        const rect = new DOMRect(
          bounds.left + gap,
          row.top,
          Math.max(160, bounds.width - gap * 2),
          row.height
        );
        openMenu(
          [
            { id: "settings", label: "Settings", icon: "Settings" },
            ...(props.onPairDevice
              ? ([{ id: "pair", label: "Pair device", icon: "Phone" }] as const)
              : []),
            ...(props.onWhatsNew
              ? ([
                  { id: "whats-new", label: "What's new", icon: "Gift" },
                ] as const)
              : []),
            ...(props.onLogOut
              ? ([
                  "sep" as const,
                  {
                    id: "logout",
                    label: "Log out",
                    icon: "ArrowRight",
                    danger: true,
                  },
                ] as const)
              : []),
          ],
          { kind: "rect", rect },
          (id) => {
            if (id === "settings") props.onSettings();
            if (id === "pair") props.onPairDevice?.();
            if (id === "whats-new") props.onWhatsNew?.();
            if (id === "logout") props.onLogOut?.();
          },
          { matchAnchorWidth: true }
        );
      }}
    >
      <span
        className={chrome.sbAccountAvatar}
        style={{ background: props.accountColor ?? identityColor(name) }}
        aria-hidden="true"
      >
        {identityInitials(name)}
      </span>
      <span className={chrome.sbAccountName}>{name}</span>
      <span className={chrome.sbMeta}>⌘,</span>
    </button>
  );
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
      data-active={props.active ? "true" : undefined}
      data-disabled={props.disabled ? "true" : undefined}
      data-accent={props.accent ? "true" : undefined}
      disabled={props.disabled}
      onClick={() => props.onClick?.()}
    >
      {props.icon}
      <span className={chrome.sbLabel}>{props.label}</span>
      {props.meta ? <span className={chrome.sbMeta}>{props.meta}</span> : null}
      {props.trailing}
    </button>
  );
}

/** Renders one NavItem from the IA model. */
function NavRow({
  item,
  activePage,
}: {
  item: NavItem;
  activePage?: SidebarPage;
}): JSX.Element {
  return (
    <SbItem
      icon={<Icon name={item.icon} size={15} />}
      label={item.label}
      {...(item.meta ? { meta: item.meta } : {})}
      active={Boolean(item.page) && item.page === activePage}
      disabled={!item.onSelect}
      {...(item.accent ? { accent: true } : {})}
      onClick={() => item.onSelect?.()}
      trailing={
        item.dot ? (
          <span
            className={chrome.notificationsUnreadDot}
            aria-label="Unread updates"
          />
        ) : undefined
      }
    />
  );
}

function SbSection({
  label,
  onAction,
}: {
  label: string;
  onAction?: () => void;
}): JSX.Element {
  return (
    <div className={chrome.sbSection}>
      <span>{label}</span>
      {onAction ? (
        <span className={chrome.sbSectionActions}>
          <button
            className={chrome.sbSectionBtn}
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
      meta={
        conversation.scopeLabel
          ? `${conversation.scopeLabel} · ${conversation.timeLabel}`
          : conversation.timeLabel
      }
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
          onMenu({ kind: "point", x: e.clientX, y: e.clientY });
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
            onMenu({
              kind: "rect",
              rect: e.currentTarget.getBoundingClientRect(),
            });
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
 * Cap recent rows before "See all" takes over. Recents is the column's body
 * now — it owns every pixel the zones above it didn't use and scrolls — so the
 * cap is a "when does this stop being a list and start being an archive"
 * threshold, not the height budget it was when Recents was one of five
 * sections fighting for space.
 */
const HISTORY_SIDEBAR_CAP = 15;

/**
 * Recents (ex-"History", ex-"Chats"): pinned first, then recent, with optional
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
  const effectiveCap = expanded
    ? Number.POSITIVE_INFINITY
    : HISTORY_SIDEBAR_CAP;
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
        ? {
            onMenu: (anchor: ShellMenuAnchor) =>
              props.onConversationMenu?.(c.id, anchor),
          }
        : {})}
      onDelete={
        props.onDeleteConversation
          ? () => props.onDeleteConversation?.(c.id)
          : undefined
      }
    />
  );

  return (
    <>
      <SbSection label="Recents" />
      {activeCount === 0 ? (
        <SbItem
          icon={<SparkleGlyph />}
          label="No chats yet"
          disabled={!props.onNewChat}
          onClick={() => props.onNewChat?.()}
        />
      ) : (
        <>
          {pinnedShow.length > 0 ? (
            <>
              <div className={chrome.sbSubLabel}>Pinned</div>
              {pinnedShow.map(row)}
              {normalShow.length > 0 ? (
                <div className={chrome.sbSubLabel}>Recent</div>
              ) : null}
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
        <button
          className={chrome.sbSeeAll}
          type="button"
          onClick={() => setExpanded(false)}
        >
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
            <Icon
              name={archivedOpen ? "ChevronDown" : "ChevronRight"}
              size={13}
            />
            <span>Archived · {archived.length}</span>
          </button>
          {archivedOpen ? archived.map(row) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * The gateway alarm. A healthy daemon says nothing at all — a standing "UP"
 * pill is a permanent reassurance nobody reads, and it cost a prime nav slot.
 * A DOWN daemon is the whole story, so it takes the foot, above the account
 * row, in the danger tone, and it is the way into the Gateway page.
 */
function GatewayAlarm(props: SidebarProps): JSX.Element | null {
  if (props.gatewayStatus !== "down") return null;
  return (
    <button
      type="button"
      className={chrome.sbAlarm}
      disabled={!props.onGateway}
      onClick={() => props.onGateway?.()}
    >
      <Icon name="Cellular" size={14} />
      <span className={chrome.sbLabel}>Gateway offline</span>
      <Icon name="ChevronRight" size={13} />
    </button>
  );
}

export default function Sidebar(props: SidebarProps): JSX.Element {
  const sections = buildNavSections(props);
  return (
    <div className={chrome.sbColumn}>
      {props.headSlot}

      <div className={chrome.sbScroll}>
        {sections.map((section) => (
          <div key={section.id} className={chrome.sbGroup}>
            {section.label ? <SbSection label={section.label} /> : null}
            {section.items.map((item) => (
              <NavRow key={item.id} item={item} activePage={props.activePage} />
            ))}
          </div>
        ))}

        <HistorySection {...props} />
      </div>

      <div className={chrome.sbFoot}>
        <GatewayAlarm {...props} />
        {props.updateVersion !== undefined && props.onRelaunchToUpdate ? (
          <button
            className={chrome.sbUpdate}
            type="button"
            onClick={() => props.onRelaunchToUpdate?.()}
            disabled={props.updateReadyToInstall === false}
          >
            <Logo size={26} />
            <span className={chrome.sbUpdateBody}>
              <span className={chrome.sbUpdateTitle}>
                {props.updatePillTitle ?? "Relaunch to update"}
              </span>
              <span className={chrome.sbUpdateVersion}>
                v{props.updateVersion}
              </span>
            </span>
            <ArrowRightGlyph />
          </button>
        ) : null}
        <AccountRow {...props} />
      </div>
    </div>
  );
}
