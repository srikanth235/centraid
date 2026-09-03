import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { PendingWriteActions } from "../../_shared/PendingWriteActions.tsx";
import { displayText, safeMediaUrl } from "../../_shared/untrusted.ts";
import { bodySegments, promote, tallyLabel } from "../format.ts";
import { resolveAnchor } from "../powerbox.ts";
import { wantsDate } from "../send-to-tasks.ts";
import type { Note, NoteAttachment, NoteReference } from "../types.ts";
import {
  ANCHOR_DEGRADED,
  BACKLINKS_NOTE,
  PENDING_CHIP,
  SEND_TO_TASKS,
  anchoredFrom,
} from "../view-copy.ts";

import styles from "./Editor.module.css";

export interface EditorProps {
  note: Note;
  body: string | undefined;
  onEdit: (patch: { title?: string; body_text?: string }) => void;
  onToggleCheck: (line: number) => void;
  onSendToTasks: (line: number, text: string) => void;
  onLink: (
    anchor: {
      exact: string;
      prefix: string;
      suffix: string;
      start: number;
    } | null
  ) => void;
  onProbe: (body: string, caret: number) => void;
  onAddTag: (label: string) => void;
  onRemoveTag: (tagId: string) => void;
  onAttach: (file: File) => void;
  onDetach: (attachmentId: string) => void;
  onOpenHistory: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}

const TOOLS: ReadonlyArray<{ key: string; glyph: string; label: string }> = [
  { key: "bold", glyph: "B", label: "Bold" },
  { key: "italic", glyph: "I", label: "Italic" },
  { key: "underline", glyph: "U", label: "Underline" },
  { key: "h1", glyph: "H1", label: "Heading" },
  { key: "h2", glyph: "H2", label: "Subheading" },
  { key: "bullet", glyph: "•", label: "Bulleted list" },
  { key: "number", glyph: "1.", label: "Numbered list" },
  { key: "check", glyph: "☐", label: "Checklist" },
  { key: "quote", glyph: "❝", label: "Quote" },
  { key: "code", glyph: "‹›", label: "Code" },
];

const WRAP: Record<string, [string, string]> = {
  bold: ["**", "**"],
  italic: ["*", "*"],
  underline: ["__", "__"],
  code: ["`", "`"],
};
const PREFIX: Record<string, string> = {
  h1: "# ",
  h2: "## ",
  bullet: "- ",
  number: "1. ",
  check: "- [ ] ",
  quote: "> ",
};

function applyTool(
  body: string,
  key: string,
  from: number,
  to: number
): string {
  const wrap = WRAP[key];
  if (wrap)
    return `${body.slice(0, from)}${wrap[0]}${body.slice(from, to)}${wrap[1]}${body.slice(to)}`;
  const prefix = PREFIX[key];
  if (!prefix) return body;
  const lineStart = body.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  return `${body.slice(0, lineStart)}${prefix}${body.slice(lineStart)}`;
}

function ChecklistRow({
  text,
  checked,
  onToggle,
  onSendToTasks,
}: {
  text: string;
  checked: boolean;
  onToggle: () => void;
  onSendToTasks?: (() => void) | undefined;
}) {
  return (
    <div className={styles.checkRow}>
      <label className={styles.check}>
        <input
          type="checkbox"
          className={styles.box}
          checked={checked}
          aria-label={displayText(text) || "Checklist item"}
          onChange={onToggle}
        />
        <span className={styles.checkText} data-done={String(checked)}>
          {displayText(text)}
        </span>
      </label>
      {onSendToTasks ? (
        <button
          type="button"
          className={`kit-plain-btn ${styles.toTask}`}
          onClick={onSendToTasks}
        >
          {SEND_TO_TASKS}
        </button>
      ) : null}
    </div>
  );
}

function References({
  references,
  body,
  noteTitle,
}: {
  references: readonly NoteReference[];
  body: string;
  noteTitle: string;
}): ReactNode {
  if (references.length === 0) return null;
  return (
    <section className={styles.block} aria-label="Links">
      {references.map((reference) => {
        const found = resolveAnchor(body, reference.selector);
        const exact = reference.selector?.exact ?? "";
        return (
          <div key={reference.link_id} className={styles.reference}>
            <span className={styles.chip}>
              {displayText(reference.card.title ?? reference.card.id)}
            </span>
            {exact ? (
              <p className={styles.passage} data-degraded={String(!found)}>
                <span className={styles.passageText}>{displayText(exact)}</span>
                <span className={styles.annot}>
                  {found ? anchoredFrom(noteTitle) : ANCHOR_DEGRADED}
                </span>
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function Attachments({
  attachments,
  onDetach,
}: {
  attachments: readonly NoteAttachment[];
  onDetach: (attachmentId: string) => void;
}): ReactNode {
  if (attachments.length === 0) return null;
  return (
    <section className={styles.block} aria-label="Files">
      {attachments.map((file) => (
        <div key={file.attachment_id} className={styles.file}>
          <span className={styles.fileName}>
            {displayText(file.title ?? file.content_id)}
          </span>
          <span className={styles.annot}>
            {displayText(file.role ?? "embed")}
          </span>
          {/* The bytes are the vault's own blob route, run through the media
              allowlist before they reach a `src`. */}
          {safeMediaUrl(file.content_uri) ? null : (
            <span className={styles.annot}>bytes arrive on request</span>
          )}
          <button
            type="button"
            className="kit-btn"
            onClick={() => onDetach(file.attachment_id)}
          >
            Remove
          </button>
        </div>
      ))}
    </section>
  );
}

export function Editor(props: EditorProps): ReactNode {
  const { note } = props;
  const shown = promote({
    title: note.title,
    body: props.body ?? "",
  });
  const [tagDraft, setTagDraft] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const [title, setTitle] = useState(shown.untitled ? "" : shown.heading);
  const [shownNoteId, setShownNoteId] = useState(note.note_id);
  const [heldBody, setHeldBody] = useState<string | undefined>(props.body);
  if (shownNoteId !== note.note_id) {
    setShownNoteId(note.note_id);
    setTitle(shown.untitled ? "" : shown.heading);
    setHeldBody(props.body);
  } else if (typeof props.body === "string" && props.body !== heldBody) {
    setHeldBody(props.body);
  }
  const body = heldBody ?? "";

  const segments = bodySegments(body);
  const tally = tallyLabel(note.check);

  const writeSegment = (from: number, to: number, text: string): void => {
    const next = `${body.slice(0, from)}${text}${body.slice(to)}`;
    props.onEdit({ body_text: next });
  };

  const runTool = (key: string): void => {
    const area = areaRef.current;
    if (!area) return;
    const base = Number(area.dataset.from ?? 0);
    const from = base + area.selectionStart;
    const to = base + area.selectionEnd;
    props.onEdit({ body_text: applyTool(body, key, from, to) });
  };

  return (
    <div className={styles.editor}>
      {/* The title is an unstyled input at the display rung — a field that
          looks like the thing it will become, so naming a note is one touch
          and never a mode. */}
      <input
        className={styles.title}
        aria-label="Note title"
        placeholder={shown.untitled ? shown.heading : ""}
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          props.onEdit({ title: event.target.value });
        }}
      />

      <div className={styles.tools} role="toolbar" aria-label="Formatting">
        {TOOLS.map((tool) => (
          <button
            key={tool.key}
            type="button"
            className={`kit-plain-btn ${styles.tool}`}
            aria-label={tool.label}
            onClick={() => runTool(tool.key)}
          >
            <span aria-hidden="true">{tool.glyph}</span>
          </button>
        ))}
        {/* The eleventh control, and the only outlined one on this row. */}
        <button
          type="button"
          className={`kit-btn ${styles.link}`}
          onClick={() => {
            const area = areaRef.current;
            if (!area) {
              props.onLink(null);
              return;
            }
            const base = Number(area.dataset.from ?? 0);
            props.onLink({
              exact: body.slice(
                base + area.selectionStart,
                base + area.selectionEnd
              ),
              prefix: body.slice(
                Math.max(0, base + area.selectionStart - 32),
                base + area.selectionStart
              ),
              suffix: body.slice(
                base + area.selectionEnd,
                base + area.selectionEnd + 32
              ),
              start: base + area.selectionStart,
            });
          }}
        >
          [[
        </button>
      </div>

      {/* The pending chip, with the words the spec gives it. It rides the
          note's own row overlay, so a queued edit says where it is without a
          second mechanism. */}
      <div className={styles.pending} title={PENDING_CHIP}>
        <PendingWriteActions row={note} />
      </div>

      <div className={styles.body}>
        {segments.map((segment) =>
          segment.kind === "check" ? (
            <ChecklistRow
              key={`check-${segment.line}`}
              text={segment.text}
              checked={segment.checked}
              onToggle={() => props.onToggleCheck(segment.line)}
              onSendToTasks={
                wantsDate(segment)
                  ? () => props.onSendToTasks(segment.line, segment.text)
                  : undefined
              }
            />
          ) : (
            <textarea
              key={`text-${segment.from}`}
              ref={areaRef}
              className={styles.text}
              aria-label="Note body"
              data-from={segment.from}
              value={segment.text}
              rows={Math.max(3, segment.text.split("\n").length)}
              onChange={(event) =>
                writeSegment(segment.from, segment.to, event.target.value)
              }
              onKeyUp={(event) =>
                props.onProbe(
                  body,
                  segment.from + event.currentTarget.selectionStart
                )
              }
            />
          )
        )}
      </div>

      {tally ? <p className={styles.annot}>{tally}</p> : null}

      <References
        references={note.references ?? []}
        body={body}
        noteTitle={shown.heading}
      />

      {/* The backlinks block says what it IS. The reverse query is a backend
          ask, so what is drawn here is the outbound rows read forwards, and
          the note under them says exactly that. */}
      {(note.backlinks ?? []).length > 0 ? (
        <section className={styles.block} aria-label="Backlinks">
          {(note.backlinks ?? []).map((backlink) => (
            <span key={backlink.link_id} className={styles.chip}>
              {displayText(backlink.card.title ?? backlink.card.id)}
            </span>
          ))}
          <p className={styles.annot}>{BACKLINKS_NOTE}</p>
        </section>
      ) : null}

      <Attachments
        attachments={note.attachments ?? []}
        onDetach={props.onDetach}
      />

      <section className={styles.block} aria-label="Tags">
        {(note.tags ?? []).map((tag) => (
          <span key={tag.tag_id} className={styles.chip}>
            {displayText(tag.label)}
            <button
              type="button"
              className={`kit-plain-btn ${styles.chipDrop}`}
              aria-label={`Remove tag ${displayText(tag.label)}`}
              onClick={() => props.onRemoveTag(tag.tag_id)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        ))}
        <input
          className={styles.tagInput}
          aria-label="Add a tag"
          value={tagDraft}
          onChange={(event) => setTagDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            props.onAddTag(tagDraft);
            setTagDraft("");
          }}
        />
      </section>

      <div className={styles.acts}>
        <button type="button" className="kit-btn" onClick={props.onTogglePin}>
          {note.pinned === 1 ? "Unpin" : "Pin"}
        </button>
        <button
          type="button"
          className="kit-btn"
          onClick={() => fileRef.current?.click()}
        >
          Attach a file
        </button>
        <button type="button" className="kit-btn" onClick={props.onOpenHistory}>
          Version history
        </button>
        <button
          type="button"
          className={`kit-btn ${styles.destructive}`}
          onClick={props.onDelete}
        >
          Delete
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        hidden
        aria-label="Attach a file to this note"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) props.onAttach(file);
        }}
      />
    </div>
  );
}
