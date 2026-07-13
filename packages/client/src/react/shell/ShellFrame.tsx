import type { JSX, ReactNode } from 'react';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ChatPanelClosedGlyph,
  ChatPanelOpenGlyph,
  PencilGlyph,
  SidebarClosedGlyph,
  SidebarOpenGlyph,
} from './glyphs.js';
import { cx } from '../ui/cx.js';
import chrome from './chrome.module.css';

// The window chrome — a `.window` grid with a sidebar column (tlSide titlebar
// row + sidebar body) and a main column (tlMain titlebar row + page content).
// Styled by the shared chrome.module.css (one module for the whole chrome
// family — see the header comment there). State (sidebarOpen) is owned by the
// caller and passed in, so the grid animates via the data-attribute.

// Titlebar icon button with tooltip + ⌘-shortcut chip.
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
        data-open={props.open ? 'true' : undefined}
        data-active={props.active ? 'true' : undefined}
        onClick={props.onClick}
      >
        {props.icon}
      </button>
      {props.title ? (
        <span className={chrome.tooltip}>
          {props.title}
          {props.shortcut ? <span className={chrome.kbd}>{props.shortcut}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

const Spacer = (): JSX.Element => <span className={chrome.spacer} aria-hidden="true" />;
const Flex = (): JSX.Element => <span style={{ flex: 1 }} />;

export interface ShellFrameProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  sidebar: ReactNode;
  children: ReactNode;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  showNewChat?: boolean;
  onNewChat?: () => void;
  /** Lead cluster hugging the back/forward arrows (Builder identity lockup). */
  titlebarLead?: ReactNode;
  /** Center cluster — mode tabs / device pill (Builder). Switches tlMain to
   *  a 2-cell grid so its left edge aligns with the right pane. */
  titlebarCenter?: ReactNode;
  /** Right-edge identity / Publish cluster. */
  titlebarRight?: ReactNode;
  showChatToggle?: boolean;
  chatPaneOpen?: boolean;
  onToggleChat?: () => void;
}

function SidebarToggle({ open, onClick }: { open: boolean; onClick?: () => void }): JSX.Element {
  return (
    <TbBtn
      icon={open ? <SidebarOpenGlyph /> : <SidebarClosedGlyph />}
      title={open ? 'Hide sidebar' : 'Show sidebar'}
      shortcut="⌘B"
      ariaLabel={open ? 'Hide sidebar' : 'Show sidebar'}
      onClick={onClick}
    />
  );
}

export default function ShellFrame(props: ShellFrameProps): JSX.Element {
  const { sidebarOpen: open } = props;

  const nav: ReactNode[] = [
    <Spacer key="sp" />,
    open ? null : <SidebarToggle key="tgl" open={false} onClick={props.onToggleSidebar} />,
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
    !open && props.showNewChat ? (
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
        icon={props.chatPaneOpen !== false ? <ChatPanelOpenGlyph /> : <ChatPanelClosedGlyph />}
        title={props.chatPaneOpen !== false ? 'Hide chat pane' : 'Show chat pane'}
        shortcut="⌘\"
        ariaLabel={props.chatPaneOpen !== false ? 'Hide chat pane' : 'Show chat pane'}
        onClick={props.onToggleChat}
      />
    ) : null,
  ].filter(Boolean);

  const tlMainContent = props.titlebarCenter ? (
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
      <Flex />
      {props.titlebarRight}
    </>
  );

  return (
    <div className={chrome.window} data-sidebar={open ? 'open' : 'closed'}>
      <aside className={chrome.sidebar}>
        <div className={chrome.tlSide}>
          <Spacer />
          <Flex />
          <SidebarToggle open onClick={props.onToggleSidebar} />
        </div>
        <div className={chrome.sidebarInner}>{props.sidebar}</div>
      </aside>
      <div className={chrome.main}>
        <div className={chrome.tlMain} data-layout={props.titlebarCenter ? 'grid' : 'flat'}>
          {tlMainContent}
        </div>
        {props.children}
      </div>
    </div>
  );
}
