import { useState } from "react";
import type { JSX } from "react";

import Icon from "../../ui/Icon.js";
import type { ShellMenuAnchor } from "../contextMenu.js";

import css from "./AssistantConversations.module.css";

// The conversation ledger — "Recents" — as APP CONTENT owned by the assistant
// route (#707).
//
// The Binding Layer's stem holds the product mark, Search and the launcher and
// nothing else, so the ledger lives here, beside the transcript it addresses.
// A shell navigation column has no business owning one app's data model:
// pinning, archiving, per-row rename/delete menus.
//
// Presentational on purpose: it owns grouping, the cap, and the two disclosure
// states, and NOTHING about fetching, sorting, or mutating conversations. The
// route above it (ultimately App.tsx) supplies the list and the handlers.

/** One row of the ledger — a persisted vault-assistant conversation, trimmed
 *  to what the row draws. */
export interface AssistantConversationEntry {
  id: string;
  title: string;
  timeLabel: string;
  /** Pinned threads render in a group above the rest (#420). */
  pinned?: boolean;
  /** Archived threads render behind a collapsed group at the bottom. */
  archived?: boolean;
  /** The vault this conversation reads, when it is NOT the member's own
   *  (#599). A conversation is pinned to one vault for life, so the row
   *  says which — but only when that is news. */
  scopeLabel?: string;
}

export interface AssistantConversationsProps {
  conversations: readonly AssistantConversationEntry[];
  activeConversationId?: string;
  onSelect?: (id: string) => void;
  onNewChat?: () => void;
  onDelete?: (id: string) => void;
  /** Row ••• / right-click menu (Rename + Delete). When present it supersedes
   *  the bare delete control. */
  onMenu?: (id: string, anchor: ShellMenuAnchor) => void;
}

/**
 * Rows shown before the ledger collapses to a "See all" control. The threshold
 * answers "when does this stop being a list and start being an archive", not a
 * height budget — the ledger column scrolls.
 */
const LEDGER_CAP = 15;

function ConversationRow({
  conversation,
  active,
  onSelect,
  onMenu,
  onDelete,
}: {
  conversation: AssistantConversationEntry;
  active: boolean;
  onSelect?: () => void;
  onMenu?: (anchor: ShellMenuAnchor) => void;
  onDelete?: () => void;
}): JSX.Element {
  // The vault only when it is news; otherwise the row is title + time.
  const meta = conversation.scopeLabel
    ? `${conversation.scopeLabel} · ${conversation.timeLabel}`
    : conversation.timeLabel;

  // Prefer the ••• menu (Rename + Delete); fall back to the bare delete control
  // when only a delete handler is wired.
  let action: JSX.Element | null = null;
  if (onMenu) {
    action = (
      <button
        className={css.rowAction}
        type="button"
        aria-label="Conversation actions"
        aria-haspopup="menu"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onMenu({
            kind: "rect",
            rect: event.currentTarget.getBoundingClientRect(),
          });
        }}
      >
        <Icon name="MoreVert" size={14} />
      </button>
    );
  } else if (onDelete) {
    action = (
      <button
        className={css.rowAction}
        type="button"
        aria-label="Delete conversation"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onDelete();
        }}
      >
        <Icon name="X" size={12} />
      </button>
    );
  }

  return (
    <div
      className={css.rowShell}
      {...(onMenu
        ? {
            onContextMenu: (event: React.MouseEvent): void => {
              event.preventDefault();
              onMenu({
                kind: "point",
                x: event.clientX,
                y: event.clientY,
              });
            },
          }
        : {})}
    >
      <button
        className={css.row}
        type="button"
        data-active={active ? "true" : undefined}
        onClick={() => onSelect?.()}
      >
        <span className={css.rowTitle}>{conversation.title}</span>
        <span className={css.rowMeta}>{meta}</span>
      </button>
      {action}
    </div>
  );
}

export default function AssistantConversations({
  conversations,
  activeConversationId,
  onSelect,
  onNewChat,
  onDelete,
  onMenu,
}: AssistantConversationsProps): JSX.Element {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const pinned = conversations.filter((c) => c.pinned && !c.archived);
  const recent = conversations.filter((c) => !c.pinned && !c.archived);
  const archived = conversations.filter((c) => c.archived);
  const activeCount = pinned.length + recent.length;
  const cap = expanded ? Number.POSITIVE_INFINITY : LEDGER_CAP;
  const pinnedShown = pinned.slice(0, cap);
  const recentShown = recent.slice(0, Math.max(0, cap - pinnedShown.length));
  const overCap = activeCount > LEDGER_CAP;

  const row = (conversation: AssistantConversationEntry): JSX.Element => (
    <ConversationRow
      key={conversation.id}
      conversation={conversation}
      active={conversation.id === activeConversationId}
      {...(onSelect ? { onSelect: () => onSelect(conversation.id) } : {})}
      {...(onMenu
        ? {
            onMenu: (anchor: ShellMenuAnchor) =>
              onMenu(conversation.id, anchor),
          }
        : {})}
      {...(onDelete ? { onDelete: () => onDelete(conversation.id) } : {})}
    />
  );

  return (
    <section className={css.ledger}>
      <header className={css.head}>
        <h2 className={css.eyebrow}>Recents</h2>
        {onNewChat ? (
          <button
            className={css.newChat}
            type="button"
            onClick={() => onNewChat()}
          >
            <Icon name="Plus" size={13} />
            <span>New chat</span>
          </button>
        ) : null}
      </header>

      <div className={css.list}>
        {activeCount === 0 ? (
          <p className={css.empty}>
            No chats yet. Start one and it lands here.
          </p>
        ) : (
          <>
            {pinnedShown.length > 0 ? (
              <>
                <div className={css.groupLabel}>Pinned</div>
                {pinnedShown.map(row)}
                {recentShown.length > 0 ? (
                  <div className={css.groupLabel}>Recent</div>
                ) : null}
              </>
            ) : null}
            {recentShown.map(row)}
          </>
        )}

        {overCap ? (
          <button
            className={css.more}
            type="button"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? (
              "Show less"
            ) : (
              <>
                {"See all · "}
                <span className={css.count}>{activeCount}</span>
              </>
            )}
          </button>
        ) : null}

        {archived.length > 0 ? (
          <>
            <button
              className={css.archivedToggle}
              type="button"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}
            >
              <Icon
                name={archivedOpen ? "ChevronDown" : "ChevronRight"}
                size={13}
              />
              <span>
                {"Archived · "}
                <span className={css.count}>{archived.length}</span>
              </span>
            </button>
            {archivedOpen ? archived.map(row) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
