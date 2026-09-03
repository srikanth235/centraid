import { memo, useEffect, useState } from "react";
import type { JSX } from "react";

import { formatBytes } from "../../format.js";
import type { AsstAttachmentDTO, AsstMsgDTO } from "../screen-contracts.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import { formatUsageLabel, formatUsageTitle } from "./assistantUsage.js";

import asstPreCss from "../styles/asstPre.module.css";
import styles from "./AssistantScreen.module.css";

function ThumbUpGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 10v11H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3zm0 0l4-7a2 2 0 0 1 2 2v3h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 18 20H7" />
    </svg>
  );
}
function ThumbDownGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M17 14V3h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-3zm0 0l-4 7a2 2 0 0 1-2-2v-3H6a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 7 4h10" />
    </svg>
  );
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export interface MessageCallbacks {
  hydrateRefs: (node: HTMLElement) => void;
  wireCodeCopy: (node: HTMLElement) => void;
  loadAttachmentImage: (hash: string, mime: string) => Promise<string>;
  onCopyMessage: (text: string) => void;
  onFeedback: (turnId: string, value: "up" | "down") => void;
  onRegenerate: () => void;
  onRetryError: (messageIndex: number) => void;
  onPagerNav: (messageIndex: number, delta: number) => void;
}

function ThinkingRow({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(streaming);
  const [seenStreaming, setSeenStreaming] = useState(streaming);
  if (seenStreaming !== streaming) {
    setSeenStreaming(streaming);
    if (!streaming) setOpen(false);
  }
  return (
    <div className={cx(styles.msg, styles.msgThinking)}>
      <details
        className={styles.thinking}
        open={open}
        data-streaming={streaming ? "true" : undefined}
      >
        <summary className={styles.thinkingSummary}>
          <span className={styles.thinkingDot} />
          {streaming ? "Thinking…" : "Thought process"}
        </summary>
        <div className={styles.thinkingBody}>{text}</div>
      </details>
    </div>
  );
}

const ATTACHMENT_THUMB_PX = 96;

function AttachmentImage({
  attachment,
  load,
}: {
  attachment: AsstAttachmentDTO;
  load: (hash: string, mime: string) => Promise<string>;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void load(attachment.hash, attachment.mime).then(
      (u) => live && setUrl(u),
      () => live && setFailed(true)
    );
    return () => {
      live = false;
    };
  }, [attachment.hash, attachment.mime, load]);
  if (failed)
    return <span className={styles.attachName}>{attachment.filename}</span>;
  return (
    <img
      className={styles.msgAttachThumb}
      src={url ?? undefined}
      alt={attachment.filename}
      width={ATTACHMENT_THUMB_PX}
      height={ATTACHMENT_THUMB_PX}
      loading="lazy"
      decoding="async"
      data-loading={url ? undefined : "true"}
    />
  );
}

function ToolsMsg({
  label,
  calls,
}: {
  label: string;
  calls: {
    tool: string;
    sql?: string;
    state: string;
    meta: string;
    outputText?: string;
    artifacts?: Array<{ label: string; hash?: string; workspacePath?: string }>;
  }[];
}): JSX.Element {
  return (
    <div className={styles.msg}>
      <details className={styles.tools}>
        <summary>{label}</summary>
        <div className={styles.toolsBody}>
          {calls.map((c, i) => (
            <div key={i} className={styles.tool} data-state={c.state}>
              {c.sql ? (
                <pre className={asstPreCss.asstPre}>{c.sql}</pre>
              ) : (
                <span>{c.tool}</span>
              )}
              {c.outputText ? (
                <pre className={asstPreCss.asstPre}>{c.outputText}</pre>
              ) : null}
              {c.artifacts?.length ? (
                <div className={styles.toolArtifacts}>
                  {c.artifacts.map((artifact, artifactIndex) => (
                    <span
                      key={`${artifact.label}-${artifactIndex}`}
                      className={styles.toolArtifact}
                      title={
                        artifact.workspacePath ??
                        (artifact.hash
                          ? `sha256 ${artifact.hash}`
                          : artifact.label)
                      }
                    >
                      <Icon name="FileEdit" size={12} />
                      {artifact.label}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className={styles.toolMeta}>{c.meta}</div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function AiActions({
  m,
  index,
  cb,
}: {
  m: Extract<AsstMsgDTO, { kind: "ai"; streaming: false }>;
  index: number;
  cb: MessageCallbacks;
}): JSX.Element | null {
  if (m.error) {
    return m.canRetry ? (
      <div className={styles.msgActions}>
        <button
          type="button"
          className={styles.msgActionBtn}
          aria-label="Retry"
          onClick={() => cb.onRetryError(index)}
        >
          <Icon name="Refresh" size={13} /> {m.offline ? "Resend" : "Retry"}
        </button>
        {m.offline ? (
          <span
            className={styles.offlineHint}
            title="Your device appears to be offline"
          >
            offline
          </span>
        ) : null}
      </div>
    ) : null;
  }
  return (
    <div className={styles.msgActions}>
      {m.retry && m.retry.count > 1 ? (
        <span className={styles.pager}>
          <button
            type="button"
            className={styles.pagerBtn}
            aria-label="Previous attempt"
            disabled={m.retry.index <= 1}
            onClick={() => cb.onPagerNav(index, -1)}
          >
            <Icon name="ArrowLeft" size={12} />
          </button>
          <span className={styles.pagerLabel}>
            {m.retry.index}/{m.retry.count}
          </span>
          <button
            type="button"
            className={styles.pagerBtn}
            aria-label="Next attempt"
            disabled={m.retry.index >= m.retry.count}
            onClick={() => cb.onPagerNav(index, 1)}
          >
            <Icon name="ArrowRight" size={12} />
          </button>
        </span>
      ) : null}
      <button
        type="button"
        className={styles.msgActionBtn}
        aria-label="Copy message"
        title="Copy"
        onClick={() => cb.onCopyMessage(m.copyText)}
      >
        <Icon name="Copy" size={13} />
      </button>
      {m.turnId ? (
        <>
          <button
            type="button"
            className={cx(
              styles.msgActionBtn,
              m.feedback === "up" && styles.feedbackOn
            )}
            aria-label="Good response"
            aria-pressed={m.feedback === "up"}
            onClick={() => cb.onFeedback(m.turnId as string, "up")}
          >
            <ThumbUpGlyph />
          </button>
          <button
            type="button"
            className={cx(
              styles.msgActionBtn,
              m.feedback === "down" && styles.feedbackOn
            )}
            aria-label="Bad response"
            aria-pressed={m.feedback === "down"}
            onClick={() => cb.onFeedback(m.turnId as string, "down")}
          >
            <ThumbDownGlyph />
          </button>
        </>
      ) : null}
      {m.canRegenerate ? (
        <button
          type="button"
          className={styles.msgActionBtn}
          aria-label="Regenerate response"
          title="Regenerate"
          onClick={() => cb.onRegenerate()}
        >
          <Icon name="Refresh" size={13} />
        </button>
      ) : null}
      {formatUsageLabel(m.usage) ? (
        <span className={styles.msgUsage} title={formatUsageTitle(m.usage)}>
          {formatUsageLabel(m.usage)}
        </span>
      ) : null}
      {m.createdAt ? (
        <span className={styles.msgTime}>{formatTime(m.createdAt)}</span>
      ) : null}
    </div>
  );
}

function MessageRow({
  m,
  index,
  cb,
}: {
  m: AsstMsgDTO;
  index: number;
  cb: MessageCallbacks;
}): JSX.Element {
  if (m.kind === "user") {
    return (
      <div className={cx(styles.msg, styles.msgUser)}>
        {m.attachments?.length ? (
          <div className={styles.msgAttachments}>
            {m.attachments.map((a, i) =>
              a.mime.startsWith("image/") ? (
                <div
                  key={`${a.hash}-${i}`}
                  className={cx(
                    styles.msgAttachChip,
                    styles.msgAttachChipImage
                  )}
                  title={a.filename}
                >
                  <AttachmentImage
                    attachment={a}
                    load={cb.loadAttachmentImage}
                  />
                </div>
              ) : (
                <div
                  key={`${a.hash}-${i}`}
                  className={styles.msgAttachChip}
                  title={a.filename}
                >
                  <span className={styles.attachName}>{a.filename}</span>
                  <span className={styles.attachSize}>
                    {formatBytes(a.sizeBytes)}
                  </span>
                </div>
              )
            )}
          </div>
        ) : null}
        {m.text ? <div>{m.text}</div> : null}
        <div className={styles.msgActions}>
          {m.text ? (
            <button
              type="button"
              className={styles.msgActionBtn}
              aria-label="Copy message"
              title="Copy"
              onClick={() => cb.onCopyMessage(m.text)}
            >
              <Icon name="Copy" size={13} />
            </button>
          ) : null}
          {m.createdAt ? (
            <span className={styles.msgTime}>{formatTime(m.createdAt)}</span>
          ) : null}
        </div>
      </div>
    );
  }
  if (m.kind === "tools") return <ToolsMsg label={m.label} calls={m.calls} />;
  if (m.kind === "thinking")
    return <ThinkingRow text={m.text} streaming={m.streaming} />;
  if (m.kind === "notice") {
    return (
      <output className={styles.notice} data-level={m.level}>
        <Icon
          name={m.level === "warn" ? "AlertTriangle" : "AlertCircle"}
          size={14}
        />
        <span>{m.text}</span>
      </output>
    );
  }
  if (m.streaming) {
    if (m.catchingUp) {
      return (
        <div className={cx(styles.msg, styles.msgAi)}>
          <output className={styles.catchUp}>
            <span className={styles.cursor} />
            <span>Connection lost — catching up…</span>
          </output>
        </div>
      );
    }
    return (
      <div className={cx(styles.msg, styles.msgAi)}>
        <div className={styles.live}>{m.text}</div>
        <span className={styles.cursor} />
      </div>
    );
  }
  return (
    <div
      className={cx(styles.msg, styles.msgAi)}
      data-error={m.error ? "true" : undefined}
    >
      <div
        ref={(node) => {
          if (node) {
            cb.hydrateRefs(node);
            cb.wireCodeCopy(node);
          }
        }}
        // oxlint-disable-next-line react/no-danger -- #639 richAnswerHtml escapes text and allowlists URLs before producing this markup.
        dangerouslySetInnerHTML={{ __html: m.html }}
      />
      <AiActions m={m} index={index} cb={cb} />
    </div>
  );
}

const Message = memo(MessageRow);
export default Message;
