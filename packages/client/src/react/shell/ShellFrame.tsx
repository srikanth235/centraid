import type { JSX, ReactNode } from "react";

import { cx } from "../ui/cx.js";
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ChatPanelClosedGlyph,
  ChatPanelOpenGlyph,
  PencilGlyph,
} from "./glyphs.js";

import chrome from "./chrome.module.css";

// The window frame (issue #707, invariant 1).
//
//   stem  |  app bar
//         |  content
//         |  status line
//
// The stem is a fixed 92px (`--w-stem`) band on the LEADING edge; on compact
// the same element becomes the bottom band and the grid flips to two rows.
// It never scrolls away and never changes width, so there is no collapse
// toggle, no drawer, and no scrim over the content — the three affordances the
// old three-zone sidebar needed and the stem does not.
//
// The main column owns the per-app bar (title in the display face, meta in the
// numeric register, and the app's own actions), the content, and the ONE
// persistent status line at the bottom of the frame. Everything positional in
// chrome.module.css is written with logical properties, so the whole frame
// mirrors under RTL without a second rule.
//
// Styled by the shared chrome.module.css — one module for the whole chrome
// family (see the header comment there), so every combinator stays in one
// scope.

// Titlebar icon button with tooltip + ⌘-shortcut chip. Still exported: the
// full-bleed hosts (app view, inline app, builder) draw their own bar out of
// these, and they are the same control.
export function TbBtn(props: {
  icon: ReactNode;
  title?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  wrapClass?: string;
  /** Keeps the button visually pressed while an anchored panel is open. */
  open?: boolean;
  /** Active toggle state (e.g. History while the pane shows history). */
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

const Spacer = (): JSX.Element => (
  <span className={chrome.spacer} aria-hidden="true" />
);
const Flex = (): JSX.Element => <span className={chrome.flex} />;

export interface ShellFrameProps {
  /** The navigation stem — leading column on desktop, bottom band on compact. */
  stem: ReactNode;
  children: ReactNode;
  /** The one persistent status line, pinned to the bottom of the main column. */
  statusLine?: ReactNode;
  /** The app's own title, in the display face. */
  appTitle?: string;
  /** The line under it, in the numeric register. */
  appMeta?: ReactNode;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  showNewChat?: boolean;
  onNewChat?: () => void;
  /** Lead cluster hugging the back/forward arrows (Builder identity lockup). */
  titlebarLead?: ReactNode;
  /** Center cluster — mode tabs / device pill (Builder). Switches the bar to
   *  a 2-cell grid so its leading edge aligns with the right pane. */
  titlebarCenter?: ReactNode;
  /** Trailing identity / commit cluster. One filled ink control, at most. */
  titlebarRight?: ReactNode;
  showChatToggle?: boolean;
  chatPaneOpen?: boolean;
  onToggleChat?: () => void;
  /** Compact form factor — the stem becomes the bottom band. Layout only. */
  compact?: boolean;
}

export default function ShellFrame(props: ShellFrameProps): JSX.Element {
  const nav: ReactNode[] = [
    <Spacer key="sp" />,
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
    props.showNewChat ? (
      <TbBtn
        key="new"
        icon={<PencilGlyph />}
        title="New app"
        shortcut="⌘N"
        ariaLabel="New app"
        onClick={props.onNewChat}
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

  // The app identity block. The title takes the display face in EVERY app —
  // it is the signature that carries the product across surfaces that
  // otherwise look nothing alike — and the meta line under it is numeric, so
  // counts and times are mono and tabular without each screen remembering to
  // ask for it.
  const identity =
    props.appTitle === undefined && props.appMeta === undefined ? null : (
      <div className={chrome.appIdentity}>
        {props.appTitle === undefined ? null : (
          <h1 className={chrome.appTitle}>{props.appTitle}</h1>
        )}
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
    >
      {props.stem}
      <div className={chrome.main}>
        <div
          className={chrome.appBar}
          data-layout={props.titlebarCenter ? "grid" : "flat"}
        >
          {barContent}
        </div>
        {props.children}
        {props.statusLine}
      </div>
    </div>
  );
}
