import type { JSX } from "react";

import type { BuilderMsgDTO } from "../screen-contracts.js";
import { Icon } from "../ui/index.js";

import chatCss from "../styles/chatMessage.module.css";
import tgCss from "../styles/toolGroup.module.css";
import styles from "./BuilderChatPane.module.css";

function BoltGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
    </svg>
  );
}

function ChevronDownGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function ToolGroup({
  message,
  onToggleGroup,
}: {
  message: Extract<BuilderMsgDTO, { kind: "toolGroup" }>;
  onToggleGroup: (id: string) => void;
}): JSX.Element {
  return (
    <div
      className={tgCss.group}
      data-testid="tool-group"
      data-open={String(message.open)}
      data-running={String(message.running)}
      data-error={String(message.error)}
      data-has-changes={String(message.change != null)}
    >
      <button
        type="button"
        className={tgCss.groupPill}
        aria-expanded={message.open}
        onClick={() => onToggleGroup(message.id)}
      >
        <span className={tgCss.bolt}>
          <BoltGlyph />
        </span>
        <span className={tgCss.label}>{message.label}</span>
        <span className={tgCss.chev}>
          <ChevronDownGlyph />
        </span>
      </button>
      {message.change && (
        <button
          type="button"
          className={styles.tgChangeCard}
          aria-label={`${message.change.count} file${message.change.count === 1 ? "" : "s"} updated — toggle details`}
          onClick={() => onToggleGroup(message.id)}
        >
          <span className={styles.tgCardIcon}>
            <Icon name="FileEdit" size={14} strokeWidth={1.7} />
          </span>
          <span className={styles.tgCardMeta}>
            <span className={styles.tgCardTitle}>
              {message.change.count} file{message.change.count === 1 ? "" : "s"}{" "}
              updated
            </span>
            <span className={styles.tgCardSub}>{message.change.subtitle}</span>
          </span>
          <span className={styles.tgCardVersion}>
            → {message.change.version}
          </span>
        </button>
      )}
      {message.open && (
        <div className={tgCss.list}>
          {message.rows.map((row, index) => (
            <div key={index} className={tgCss.row} data-state={row.state}>
              <span className={tgCss.dot} data-state={row.state} />
              <span className={tgCss.rowName}>{row.verb}</span>
              <span className={tgCss.rowTarget}>{row.target}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BuilderChatMessage({
  message,
  onToggleGroup,
}: {
  message: BuilderMsgDTO;
  onToggleGroup: (id: string) => void;
}): JSX.Element {
  switch (message.kind) {
    case "divider":
      return (
        <div className={styles.chatDivider}>
          <span>{message.text}</span>
        </div>
      );
    case "status":
      return (
        <div className={styles.chatStatusRow}>
          <span className={chatCss.status}>
            {message.spinning ? (
              <span className={chatCss.pulse} />
            ) : (
              <Icon name="Check" size={12} strokeWidth={2.5} />
            )}
            {" " + message.text}
          </span>
        </div>
      );
    case "user":
      return (
        <div className={chatCss.user}>
          <div className={chatCss.userBubble}>{message.text}</div>
        </div>
      );
    case "thinking":
      return (
        <div
          className={styles.chatThinking}
          data-streaming={String(message.streaming)}
        >
          <div className={styles.thinkingHeader}>
            <span className={styles.thinkingDot} />
            <span>{message.header}</span>
          </div>
          <div className={styles.thinkingBody}>{message.text}</div>
        </div>
      );
    case "toolGroup":
      return <ToolGroup message={message} onToggleGroup={onToggleGroup} />;
    case "ai":
      return (
        <div className={chatCss.ai}>
          <span className={styles.msgAiAvatar}>
            <Icon name="Sparkle" size={11} />
          </span>
          <div className={chatCss.aiText} data-testid="builder-ai-text">
            {message.paras.map((paragraph, index) => (
              <p key={index}>{paragraph}</p>
            ))}
          </div>
        </div>
      );
  }
}
