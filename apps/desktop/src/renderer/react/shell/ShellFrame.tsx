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

// React port of the vanilla `buildWindow` (chrome.ts). Builds the `.cd-window`
// grid — a sidebar column (tlSide titlebar row + sidebar body) and a main
// column (tlMain titlebar row + page content) — rendering the same global
// chrome classes. State (sidebarOpen) is owned by the caller and passed in, so
// the grid animates via the data-attribute exactly as the vanilla setter did.

// Titlebar icon button with tooltip + ⌘-shortcut chip (port of chrome tbBtn).
export function TbBtn(props: {
  icon: ReactNode;
  title?: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  wrapClass?: string;
}): JSX.Element {
  return (
    <span className={props.wrapClass ? `cd-tb-btn-wrap ${props.wrapClass}` : 'cd-tb-btn-wrap'}>
      <button
        className="cd-tb-btn"
        type="button"
        aria-label={props.ariaLabel ?? props.title}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.icon}
      </button>
      {props.title ? (
        <span className="cd-tooltip">
          {props.title}
          {props.shortcut ? <span className="cd-kbd">{props.shortcut}</span> : null}
        </span>
      ) : null}
    </span>
  );
}

const Spacer = (): JSX.Element => (
  <span className="cd-traffic-lights-spacer" aria-hidden="true" />
);
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
        wrapClass="chat-toggle-wrap"
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
      <div className="cd-tl-nav">{nav}</div>
      <div className="cd-tl-context">
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
    <div className="cd-window" data-sidebar={open ? 'open' : 'closed'}>
      <aside className="cd-sidebar">
        <div className="cd-tl-side">
          <Spacer />
          <Flex />
          <SidebarToggle open onClick={props.onToggleSidebar} />
        </div>
        <div className="cd-sidebar-inner">{props.sidebar}</div>
      </aside>
      <div className="cd-main">
        <div className="cd-tl-main" data-layout={props.titlebarCenter ? 'grid' : 'flat'}>
          {tlMainContent}
        </div>
        {props.children}
      </div>
    </div>
  );
}
