import { useState } from "react";
import type { JSX } from "react";

import Icon from "../../ui/Icon.js";
import type { ShellMenuAnchor } from "../contextMenu.js";

import css from "./AssistantConversations.module.css";

export interface AssistantConversationEntry {
  id: string;
  title: string;
  timeLabel: string;
  pinned?: boolean;
  archived?: boolean;
  scopeLabel?: string;
}

export interface AssistantConversationsProps {
  conversations: readonly AssistantConversationEntry[];
  activeConversationId?: string;
  onSelect?: (id: string) => void;
  onNewChat?: () => void;
  onDelete?: (id: string) => void;
  onMenu?: (id: string, anchor: ShellMenuAnchor) => void;
}

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
  const meta = conversation.scopeLabel
    ? `${conversation.scopeLabel} · ${conversation.timeLabel}`
    : conversation.timeLabel;

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
