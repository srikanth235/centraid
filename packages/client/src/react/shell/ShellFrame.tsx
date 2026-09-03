import type { JSX, ReactNode } from "react";

import { isWebHost } from "../host-platform.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ChatPanelClosedGlyph,
  ChatPanelOpenGlyph,
  SidebarClosedGlyph,
  SidebarOpenGlyph,
} from "./glyphs.js";

import chrome from "./chrome.module.css";

export function TbBtn(props: {
  icon: ReactNode;
  title?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  wrapClass?: string;
  open?: boolean;
  active?: boolean;
}): JSX.Element {
  return (
    <span className={cx(chrome.tbBtnWrap, props.wrapClass)}>
      <button
        className={chrome.tbBtn}
        type="button"
        aria-label={props.ariaLabel ?? props.title}
        disabled={props.disabled}
        data-open={props.open ? "true" : undefined}
        data-active={props.active ? "true" : undefined}
        onClick={props.onClick}
      >
        {props.icon}
      </button>
      {props.title ? (
        <span className={chrome.tooltip}>
          {props.title}
          {props.shortcut ? (
            <span className={chrome.kbd}>{props.shortcut}</span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

const Flex = (): JSX.Element => <span className={chrome.flex} />;

export interface ShellFrameProps {
  stem: ReactNode;
  children: ReactNode;
  statusLine?: ReactNode;
  assistantCompanion?: ReactNode;
  assistantOpen?: boolean;
  onToggleAssistant?: () => void;
  appTitle?: string;
  appMeta?: ReactNode;
  appCount?: ReactNode;
  appMark?: ReactNode;
  appTitleAction?: {
    onActivate: (anchor: DOMRect) => void;
    label: string;
    open?: boolean;
    anchorRef?: (el: HTMLButtonElement | null) => void;
  };
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  titlebarLead?: ReactNode;
  titlebarCenter?: ReactNode;
  titlebarRight?: ReactNode;
  showChatToggle?: boolean;
  chatPaneOpen?: boolean;
  onToggleChat?: () => void;
  compact?: boolean;
  band?: ReactNode;
  stemOpen?: boolean;
  onToggleStem?: () => void;
}

export default function ShellFrame(props: ShellFrameProps): JSX.Element {
  const nav: ReactNode[] = [
    props.stemOpen === undefined ? null : (
      <TbBtn
        key="stem"
        icon={props.stemOpen ? <SidebarOpenGlyph /> : <SidebarClosedGlyph />}
        title={props.stemOpen ? "Hide sidebar" : "Show sidebar"}
        shortcut="⌘B"
        ariaLabel={props.stemOpen ? "Hide sidebar" : "Show sidebar"}
        onClick={props.onToggleStem}
      />
    ),
    <TbBtn
      key="back"
      icon={<ArrowLeftGlyph />}
      title="Back"
      shortcut="⌘["
      ariaLabel="Back"
      disabled={!props.canGoBack}
      onClick={props.onBack}
    />,
    <TbBtn
      key="fwd"
      icon={<ArrowRightGlyph />}
      title="Forward"
      shortcut="⌘]"
      ariaLabel="Forward"
      disabled={!props.canGoForward}
      onClick={props.onForward}
    />,
    props.onToggleAssistant ? (
      <TbBtn
        key="assistant"
        icon={<ChatPanelClosedGlyph />}
        title={props.assistantOpen ? "Close Assistant" : "Open Assistant"}
        shortcut="⌘J"
        ariaLabel={props.assistantOpen ? "Close Assistant" : "Open Assistant"}
        open={props.assistantOpen}
        onClick={props.onToggleAssistant}
      />
    ) : null,
    props.titlebarLead ?? null,
    props.showChatToggle ? (
      <TbBtn
        key="chat"
        wrapClass={chrome.chatToggleWrap}
        icon={
          props.chatPaneOpen === false ? (
            <ChatPanelClosedGlyph />
          ) : (
            <ChatPanelOpenGlyph />
          )
        }
        title={
          props.chatPaneOpen === false ? "Show chat pane" : "Hide chat pane"
        }
        shortcut="⌘\"
        ariaLabel={
          props.chatPaneOpen === false ? "Show chat pane" : "Hide chat pane"
        }
        onClick={props.onToggleChat}
      />
    ) : null,
  ].filter(Boolean);

  const { anchorRef, label, onActivate, open } = props.appTitleAction ?? {};
  const title =
    props.appTitle === undefined ? null : props.appTitleAction ? (
      <button
        ref={anchorRef}
        className={cx(chrome.appTitle, chrome.appTitleBtn)}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
        aria-label={label}
        data-open={open ? "true" : undefined}
        onClick={(event) =>
          onActivate?.(event.currentTarget.getBoundingClientRect())
        }
      >
        <span className={chrome.appTitleText}>{props.appTitle}</span>
        {/* Decoration inside the control, not a second target. */}
        <Icon name="ChevronDown" size={15} strokeWidth={2.2} />
      </button>
    ) : (
      <h1 className={chrome.appTitle}>{props.appTitle}</h1>
    );
  const lockup =
    props.appMark === undefined && props.appCount === undefined ? (
      title
    ) : (
      <div className={chrome.appLockup}>
        {props.appMark}
        {title}
        {props.appCount === undefined ? null : (
          <span className={chrome.appCount}>{props.appCount}</span>
        )}
      </div>
    );
  const identity =
    props.appTitle === undefined &&
    props.appMeta === undefined &&
    props.appMark === undefined ? null : (
      <div className={chrome.appIdentity}>
        {lockup}
        {props.appMeta === undefined ? null : (
          <div className={chrome.appMeta}>{props.appMeta}</div>
        )}
      </div>
    );

  const barContent = props.titlebarCenter ? (
    <>
      <div className={chrome.tlNav}>{nav}</div>
      <div className={chrome.tlContext}>
        {props.titlebarCenter}
        {props.titlebarRight ? (
          <>
            <Flex />
            {props.titlebarRight}
          </>
        ) : null}
      </div>
    </>
  ) : (
    <>
      {nav}
      {identity}
      <Flex />
      {props.titlebarRight}
    </>
  );

  return (
    <div
      className={chrome.window}
      data-compact={props.compact ? "true" : undefined}
      data-window-controls={isWebHost() ? undefined : "inset"}
      data-stem={props.stemOpen === false ? "hidden" : undefined}
    >
      {/* ONE band, always: a claimed band REPLACES the stem, so "one band
          exists" is a property of this expression. */}
      {props.compact && props.band ? props.band : props.stem}
      <div
        className={chrome.main}
        data-assistant-main="true"
        data-assistant={props.assistantOpen ? "open" : undefined}
        data-compact={props.compact ? "true" : undefined}
      >
        <div
          className={chrome.appBar}
          data-assistant-chrome="true"
          data-layout={props.titlebarCenter ? "grid" : "flat"}
          data-lockup={props.appMark === undefined ? undefined : "app"}
          data-identity={props.appMeta === undefined ? undefined : "true"}
        >
          {barContent}
        </div>
        {props.children}
        {props.statusLine}
        {props.assistantCompanion}
      </div>
    </div>
  );
}
