import type { JSX, ReactNode } from "react";

import { isWebHost } from "../host-platform.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ChatPanelClosedGlyph,
  ChatPanelOpenGlyph,
  PencilGlyph,
  SidebarClosedGlyph,
  SidebarOpenGlyph,
} from "./glyphs.js";

import chrome from "./chrome.module.css";

// The window frame (issue #707, invariant 1).
//
//   stem  |  app bar
//         |  content
//         |  status line
//
// The stem is a fixed `--w-stem` band on the LEADING edge; on compact
// the same element becomes the bottom band and the grid flips to two rows.
// It never scrolls away and never changes width, so there is no collapse
// toggle, no drawer, and no scrim over the content — the three affordances the
// old three-zone sidebar needed and the stem does not.
//
// The main column owns the per-app bar (title role, display for a full identity
// lockup, meta in the numeric register, and the app's own actions), the content, and the ONE
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

const Flex = (): JSX.Element => <span className={chrome.flex} />;

export interface ShellFrameProps {
  /** The navigation stem — leading column on desktop, bottom band on compact. */
  stem: ReactNode;
  children: ReactNode;
  /** The one persistent status line, pinned to the bottom of the main column. */
  statusLine?: ReactNode;
  /** The app's own title; a full identity lockup promotes it to display. */
  appTitle?: string;
  /** The line under it, in the numeric register. */
  appMeta?: ReactNode;
  /** A count BESIDE the title, on the same line (Photos v4, §3). The frame
   *  renders it in the numeric register — the caller passes the number, never
   *  the styling. Unlike `appMeta` it does not turn the bar into a header:
   *  "1,904 photographs" beside the title names the same screen, it does not
   *  become a second row of identity. */
  appCount?: ReactNode;
  /** The app's own mark, leading the title in the bar lockup. */
  appMark?: ReactNode;
  /** Makes the title itself a control (issue #708). Home's title is the vault
   *  name, and a vault name that names a CHOICE should be the thing you press
   *  to change it — one switcher, at the size the brief already gives the
   *  title, rather than a second identity row competing with it. */
  appTitleAction?: {
    onActivate: (anchor: DOMRect) => void;
    /** What the control announces — the title alone does not say it switches. */
    label: string;
    /** Whether the anchored picker is open (a styling + `aria-expanded` hook). */
    open?: boolean;
    /** A ref CALLBACK, not a `RefObject`. A ref object reachable through a
     *  plain props object makes react-compiler treat every read of that object
     *  as a during-render ref access, and the whole component bails out of
     *  compilation. A callback carries no `current` to read. */
    anchorRef?: (el: HTMLButtonElement | null) => void;
  };
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
  /**
   * A band the ROUTE claims, on the compact surface (Photos v4, CHANGELOG F).
   *
   * When one is given and the form factor is compact, it renders INSTEAD of
   * the stem — the frame renders one band or the other, so "exactly one band
   * exists at any moment" is a property of this expression rather than a rule
   * two components have to keep. It is ignored on desktop, where the stem is a
   * column and there is no band to claim.
   */
  band?: ReactNode;
  /** Whether the stem column is showing. Undefined = no toggle at all, which
   *  is what the compact band and every full-bleed host want. */
  stemOpen?: boolean;
  onToggleStem?: () => void;
}

export default function ShellFrame(props: ShellFrameProps): JSX.Element {
  // The stem toggle leads the bar, ahead of history: it changes what the frame
  // IS, and history changes what is in it. It is present in both states rather
  // than only when the stem is hidden — a control that disappears once you use
  // it makes the member hunt for the way back.
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

  // The app identity block. A bare screen name takes the title role; a full
  // lockup promotes it to display, and the meta line under it is numeric, so
  // counts and times are mono and tabular without each screen remembering to
  // ask for it.
  // Destructured, never read as `action.x` in the JSX below: handing a member
  // expression to `ref=` marks its whole owning object as a ref for
  // react-compiler, and every other read of that object then trips the
  // "no refs during render" rule and bails this component out of compilation.
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
        {/* The stepper a native `<select>` wears: decoration inside the one
            control, not a second target at the trailing edge. */}
        <Icon name="ChevronDown" size={15} strokeWidth={2.2} />
      </button>
    ) : (
      <h1 className={chrome.appTitle}>{props.appTitle}</h1>
    );
  // The lockup: the app's mark, its title, and a count on the same line. The
  // count never becomes a meta line — a number beside the title names the same
  // screen, while a line under it is a second row of identity.
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
      // The desktop window is `titleBarStyle: "hiddenInset"`, so macOS draws
      // its close/minimise/zoom buttons INSIDE the client area at the leading
      // top corner — which is the stem's corner. The stem reserves that strip
      // rather than painting under it; on a browser host there is no such
      // strip and reserving one would be dead space.
      data-window-controls={isWebHost() ? undefined : "inset"}
      // Hidden, not unmounted: the launcher keeps its scroll position and the
      // switcher keeps its anchor, so ⌘⇧G still opens under the same control.
      data-stem={props.stemOpen === false ? "hidden" : undefined}
    >
      {/* ONE band, always. A claimed band replaces the stem rather than
          standing beside a hidden one, so there is no state in which both
          exist and none in which neither does. */}
      {props.compact && props.band ? props.band : props.stem}
      <div className={chrome.main}>
        <div
          className={chrome.appBar}
          data-layout={props.titlebarCenter ? "grid" : "flat"}
          // The app lockup (mark · title · count) rather than the bare
          // titlebar title — the app-bar type rung, not the header's.
          data-lockup={props.appMark === undefined ? undefined : "app"}
          // A bar carrying an app's identity LOCKUP is a HEADER, not a
          // titlebar: the brief gives it the display face at 31px over a mono
          // meta line, and that block needs the rhythm's larger steps around
          // it to read as the top of a page rather than as window furniture.
          // The trigger is the META line, not the title: a bar with a title
          // and nothing under it is naming the screen, which is what a
          // titlebar has always done, so it stays the tight strip.
          data-identity={props.appMeta === undefined ? undefined : "true"}
        >
          {barContent}
        </div>
        {props.children}
        {props.statusLine}
      </div>
    </div>
  );
}
