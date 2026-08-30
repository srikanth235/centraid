import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent, ReactNode } from "react";

import type { ConversationAttachmentRef } from "../../../gateway-client.js";
import Button from "../../ui/Button.js";
import Icon from "../../ui/Icon.js";
import ShellModal from "../../ui/ShellModal.js";
import {
  assistantConsequence,
  assistantWorkingLine,
  initialAssistantSelection,
  resolveAssistantSelection,
} from "./assistantCompanionModel.js";
import type {
  AssistantCompanionSurface,
  AssistantHarnessOption,
  AssistantSelection,
} from "./assistantCompanionModel.js";
import AssistantCompanionPicker from "./AssistantCompanionPicker.js";

import css from "./AssistantCompanion.module.css";

export type AssistantAttachmentSource =
  | "document"
  | "photo"
  | "page"
  | "device-file"
  | "link";

export type AssistantCompanionAttachment = {
  id: string;
  label: string;
  source?: AssistantAttachmentSource;
  text?: string;
  ref?: ConversationAttachmentRef;
};
export type AssistantCompanionMessage = {
  id: string;
  author: "you" | "assistant";
  meta: string;
  content: ReactNode;
};

export type AssistantCompanionSend = {
  text: string;
  selection: AssistantSelection;
  attachmentIds: readonly string[];
  includeContext: boolean;
};

export interface AssistantCompanionProps {
  surface: AssistantCompanionSurface;
  catalog: readonly AssistantHarnessOption[];
  messages: readonly AssistantCompanionMessage[];
  attachments?: readonly AssistantCompanionAttachment[];
  contextLabel?: string;
  working?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  selection?: AssistantSelection;
  defaultSelection?: AssistantSelection;
  className?: string;
  railClassName?: string;
  onOpenChange?: (open: boolean) => void;
  onRailOpenChange?: (open: boolean) => void;
  onSelectionChange?: (selection: AssistantSelection) => void;
  onRemoveAttachment: (id: string) => void;
  onRequestAttachment: (
    source: AssistantAttachmentSource,
    payload?: File | string
  ) => void;
  onOpenFull?: () => void;
  onSend: (request: AssistantCompanionSend) => void;
  onStop: () => void;
}

const ATTACHMENT_SOURCES: readonly [AssistantAttachmentSource, string][] = [
  ["document", "Choose a document file"],
  ["photo", "Choose a photo file"],
  ["page", "This page as text"],
  ["device-file", "Choose a file from this device"],
  ["link", "Add a link URL"],
];
const NO_ATTACHMENTS: readonly AssistantCompanionAttachment[] = [];

export default function AssistantCompanion({
  surface,
  catalog,
  messages,
  attachments = NO_ATTACHMENTS,
  contextLabel,
  working = false,
  open: controlledOpen,
  defaultOpen = false,
  selection: controlledSelection,
  defaultSelection,
  className,
  railClassName,
  onOpenChange,
  onRailOpenChange,
  onSelectionChange,
  onRemoveAttachment,
  onRequestAttachment,
  onOpenFull,
  onSend,
  onStop,
}: AssistantCompanionProps): JSX.Element | null {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const [localSelection, setLocalSelection] = useState(() =>
    initialAssistantSelection(catalog, defaultSelection)
  );
  const [contextIncluded, setContextIncluded] = useState(Boolean(contextLabel));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [linkEntryOpen, setLinkEntryOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState("");
  const [draft, setDraft] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const deviceFileInputRef = useRef<HTMLInputElement>(null);
  const open = controlledOpen ?? localOpen;
  const selection =
    controlledSelection ??
    localSelection ??
    initialAssistantSelection(catalog, defaultSelection);
  const resolved = resolveAssistantSelection(catalog, selection);
  const canSend = Boolean(
    draft.trim() && resolved?.harness.installed && !working
  );

  const setOpen = useCallback(
    (next: boolean): void => {
      if (controlledOpen === undefined) setLocalOpen(next);
      onOpenChange?.(next);
    },
    [controlledOpen, onOpenChange]
  );

  const setSelection = (next: AssistantSelection): void => {
    if (controlledSelection === undefined) setLocalSelection(next);
    onSelectionChange?.(next);
  };

  useEffect(() => {
    if (surface === "pointer") onRailOpenChange?.(open);
  }, [onRailOpenChange, open, surface]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setOpen(!open);
        return;
      }
      if (event.key !== "Escape" || !open) return;
      event.preventDefault();
      if (pickerOpen) setPickerOpen(false);
      else if (attachmentMenuOpen) setAttachmentMenuOpen(false);
      else setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [attachmentMenuOpen, open, pickerOpen, setOpen]);

  useEffect(() => {
    if (!open) return;
    composerRef.current?.focus();
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [messages.length, open]);

  const submit = (): void => {
    if (!canSend || !selection) return;
    onSend({
      attachmentIds: attachments.map((attachment) => attachment.id),
      includeContext: contextIncluded,
      selection,
      text: draft.trim(),
    });
    setDraft("");
  };

  const requestAttachment = (source: AssistantAttachmentSource): void => {
    if (source === "document") documentInputRef.current?.click();
    else if (source === "photo") photoInputRef.current?.click();
    else if (source === "device-file") deviceFileInputRef.current?.click();
    else if (source === "link") setLinkEntryOpen(true);
    else onRequestAttachment(source);
  };

  const onComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>
  ): void => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    submit();
  };

  if (!open) {
    if (surface === "touch") return null;
    return (
      <button
        className={[css.askPill, className].filter(Boolean).join(" ")}
        type="button"
        aria-label="Ask Assistant"
        onClick={() => setOpen(true)}
      >
        <Icon name="Sparkle" size={26} />
        <span>Ask</span>
        <kbd>{navigator.platform.includes("Mac") ? "⌘J" : "Ctrl J"}</kbd>
      </button>
    );
  }

  const workingLine = assistantWorkingLine(resolved);
  return (
    <>
      {surface === "touch" ? (
        <button
          className={css.scrim}
          type="button"
          aria-label="Close Assistant"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <ShellModal
        layer="inline"
        className={[
          css.panel,
          className,
          surface === "pointer" ? railClassName : null,
        ]
          .filter(Boolean)
          .join(" ")}
        data={{ "data-surface": surface }}
        label="Assistant companion"
      >
        <header className={css.head}>
          <Icon name="Sparkle" size={26} />
          <h2>Assistant</h2>
          {surface === "pointer" && onOpenFull ? (
            <button
              className={css.textAction}
              type="button"
              onClick={onOpenFull}
            >
              Open full
            </button>
          ) : null}
          <button
            className={css.iconButton}
            type="button"
            aria-label="Close Assistant"
            onClick={() => setOpen(false)}
          >
            <Icon name="X" size={16} />
          </button>
        </header>

        {contextIncluded && contextLabel ? (
          <div className={css.contextRow}>
            <span className={css.contextChip}>
              <span>Reading {contextLabel}</span>
              <Button
                variant="quiet"
                ariaLabel="Remove page context"
                onClick={() => setContextIncluded(false)}
              >
                <Icon name="X" size={12} />
              </Button>
            </span>
          </div>
        ) : null}

        <div className={css.thread} ref={threadRef} aria-live="polite">
          {messages.map((message) => (
            <article
              className={css.message}
              data-author={message.author}
              key={message.id}
            >
              <div className={css.messageMeta}>{message.meta}</div>
              <div className={css.messageText}>{message.content}</div>
            </article>
          ))}
          {working && workingLine ? (
            <div className={css.working}>{workingLine}</div>
          ) : null}
        </div>

        {pickerOpen && selection && resolved ? (
          <AssistantCompanionPicker
            surface={surface}
            catalog={catalog}
            selection={selection}
            resolved={resolved}
            onChange={setSelection}
          />
        ) : null}

        <div className={css.composerArea}>
          {attachments.length > 0 ? (
            <div className={css.attachments} aria-label="Attachments">
              {attachments.map((attachment) => (
                <span className={css.attachmentChip} key={attachment.id}>
                  <span>{attachment.label}</span>
                  <Button
                    variant="quiet"
                    ariaLabel={`Remove ${attachment.label}`}
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    <Icon name="X" size={11} />
                  </Button>
                </span>
              ))}
            </div>
          ) : null}

          <button
            className={css.harnessBar}
            data-open={pickerOpen ? "true" : undefined}
            type="button"
            aria-expanded={pickerOpen}
            disabled={!resolved}
            onClick={() => {
              setAttachmentMenuOpen(false);
              setPickerOpen((value) => !value);
            }}
          >
            <span>
              {resolved
                ? `${resolved.harness.label} · ${resolved.model.label}`
                : "No harness available"}
            </span>
            {resolved?.effort ? (
              <span className={css.effortPill}>{resolved.effort.label}</span>
            ) : null}
            <Icon name="ChevronDown" size={14} />
          </button>

          <div className={css.composerRow}>
            <div className={css.attachmentAnchor}>
              <button
                className={css.addButton}
                type="button"
                aria-label="Add attachment"
                aria-expanded={attachmentMenuOpen}
                onClick={() => {
                  setPickerOpen(false);
                  setAttachmentMenuOpen((value) => !value);
                }}
              >
                <Icon name="Plus" size={17} />
              </button>
              {attachmentMenuOpen ? (
                <div className={css.attachmentMenu} role="menu">
                  {ATTACHMENT_SOURCES.map(([source, label]) => (
                    <button
                      key={source}
                      className={css.attachmentMenuItem}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAttachmentMenuOpen(false);
                        requestAttachment(source);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                ref={documentInputRef}
                hidden
                type="file"
                accept=".txt,.md,.markdown,.csv,.json,.pdf,text/*,application/pdf"
                aria-label="Choose document file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) onRequestAttachment("document", file);
                  event.currentTarget.value = "";
                }}
              />
              <input
                ref={photoInputRef}
                hidden
                type="file"
                accept="image/*"
                aria-label="Choose photo file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) onRequestAttachment("photo", file);
                  event.currentTarget.value = "";
                }}
              />
              <input
                ref={deviceFileInputRef}
                hidden
                type="file"
                aria-label="Choose file from this device"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) onRequestAttachment("device-file", file);
                  event.currentTarget.value = "";
                }}
              />
            </div>
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              aria-label="Ask Assistant"
              placeholder={
                contextIncluded && contextLabel
                  ? `Ask about ${contextLabel}`
                  : "Ask about anything in this vault"
              }
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={onComposerKeyDown}
            />
            <button
              className={css.sendButton}
              data-active={working || canSend ? "true" : undefined}
              type="button"
              aria-label={working ? "Stop response" : "Send message"}
              disabled={!working && !canSend}
              onClick={() => (working ? onStop() : submit())}
            >
              <span className={working ? undefined : css.sendArrow}>
                <Icon
                  name={working ? "Stop" : "ArrowRight"}
                  size={15}
                  strokeWidth={2}
                />
              </span>
            </button>
          </div>
          {linkEntryOpen ? (
            <div className={css.linkEntry}>
              <input
                aria-label="Link URL"
                type="url"
                placeholder="https://…"
                value={linkDraft}
                onChange={(event) => setLinkDraft(event.currentTarget.value)}
              />
              <Button
                variant="secondary"
                label="Add link"
                disabled={!linkDraft.trim()}
                onClick={() => {
                  onRequestAttachment("link", linkDraft.trim());
                  setLinkDraft("");
                  setLinkEntryOpen(false);
                }}
              />
            </div>
          ) : null}
          <p
            className={css.foot}
            data-unavailable={
              resolved && !resolved.harness.installed ? "true" : undefined
            }
          >
            {assistantConsequence(resolved, attachments.length)}
          </p>
        </div>
      </ShellModal>
    </>
  );
}
