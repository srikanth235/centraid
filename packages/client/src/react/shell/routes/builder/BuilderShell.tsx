import { Store } from '../../store.js';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppearancePrefs } from '../../../../app-shell-context.js';
import { useShellActions } from '../../actions.js';
import { iconSvg } from '../../iconSvg.js';
import type { ShellNav } from '../../ShellApp.js';
import ShellFrame from '../../ShellFrame.js';
import BuilderChatPane from '../../../screens/BuilderChatPane.js';
import BuilderAutomationPane from './BuilderAutomationPane.js';
import BuilderCloud from './BuilderCloud.js';
import BuilderCode from './BuilderCode.js';
import BuilderHistory from './BuilderHistory.js';
import BuilderPreview from './BuilderPreview.js';
import type { Tab } from './builderModel.js';
import { type UseBuilderInput, useBuilder } from './useBuilder.js';
import styles from './BuilderShell.module.css';
import chrome from '../../chrome.module.css';
import rightPaneCss from './rightPane.module.css';
import buttonCss from '../../../ui/Button.module.css';
import { cx } from '../../../ui/cx.js';

// Inline device/reload glyphs (mirror builder.ts) — not in the design-token set.
const SmartphoneIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
const TabletIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
const MonitorIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const RefreshIcon =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>';

const APP_TABS: [Tab, string, string][] = [
  ['preview', 'Preview', 'Eye'],
  ['code', 'Code', 'Code'],
  ['cloud', 'Cloud', 'Bolt'],
];
const AUTO_TABS: [Tab, string, string][] = [
  ['config', 'Config', 'Settings'],
  ['flow', 'Flow', 'Activity'],
  ['runs', 'Runs', 'History'],
  ['code', 'Code', 'Code'],
];

function formatPreviewUrl(src: string): string {
  try {
    const u = new URL(src);
    if (u.pathname.includes('/_draft/')) return 'Draft preview';
    return u.host + (u.pathname === '/' ? '' : u.pathname);
  } catch {
    return src;
  }
}

const CHAT_PANE_PREF = 'builder.chatPaneOpen';

export interface BuilderShellProps extends UseBuilderInput {
  nav: ShellNav;
  renderSidebar: (nav: ShellNav) => ReactNode;
  prefs: AppearancePrefs;
  onToggleSidebar: () => void;
}

export default function BuilderShell(props: BuilderShellProps): JSX.Element {
  const { nav, renderSidebar, prefs, onToggleSidebar, ...builderInput } = props;
  const { showToast } = useShellActions();
  const vm = useBuilder(builderInput);

  const [chatOpenPref, setChatOpenPref] = useState<boolean>(() =>
    Store.get<boolean>(CHAT_PANE_PREF, true),
  );
  const [previewInfo, setPreviewInfo] = useState<{ src: string } | null>(null);

  // Name lockup: set text imperatively so React never clobbers a mid-edit caret.
  const nameRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (nameRef.current && nameRef.current.textContent !== vm.projName) {
      nameRef.current.textContent = vm.projName;
    }
  }, [vm.projName]);

  // Version-history sub-root (mounted into the host BuilderChatPane provides).
  const historyRoots = useRef(new Map<HTMLElement, Root>());
  useEffect(() => {
    const roots = historyRoots.current;
    return () => {
      roots.forEach((r) => r.unmount());
      roots.clear();
    };
  }, []);

  // Chat pane only exists on Preview (app) or every automation tab; ⌘\ toggles.
  const chatEligible = vm.isAutomation || vm.tab === 'preview';
  const chatVisible = chatEligible && chatOpenPref;
  const toggleChat = (): void => {
    if (!chatEligible) return;
    setChatOpenPref((open) => {
      const next = !open;
      Store.set(CHAT_PANE_PREF, next);
      return next;
    });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== '\\') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      toggleChat();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (#325) listener re-bound only on chatEligible, toggleChat is stable
  }, [chatEligible]);

  const finish = window.CentraidTokens.tileFinish(vm.projColor, 'gradient');

  // ── Titlebar lead: identity lockup ──────────────────────────────────────
  const titlebarLead = (
    <span className={styles.tlIdentity}>
      <span
        className={styles.tlAppIcon}
        style={{
          background: finish.background,
          color: finish.glyphColor,
          boxShadow: finish.boxShadow || undefined,
        }}
        dangerouslySetInnerHTML={{ __html: iconSvg(vm.projIcon || 'Sparkle', 11, 1.9) }}
      />
      <b
        ref={nameRef}
        role="textbox"
        aria-label="App name"
        contentEditable={vm.isAutomation ? false : 'plaintext-only'}
        spellCheck={false}
        suppressContentEditableWarning
        title={vm.isAutomation ? undefined : 'Click to rename'}
        onBlur={(e) => vm.commitRename(e.currentTarget.textContent ?? '')}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.currentTarget.textContent = vm.projName;
            e.currentTarget.blur();
          }
        }}
      />
      <span className={styles.tlStatus} data-state={vm.statusState}>
        <span className={styles.tlStatusDot} />
        <span>{vm.statusText}</span>
      </span>
    </span>
  );

  // ── Titlebar right: history, more, primary ──────────────────────────────
  const primaryGlyph =
    vm.primaryKind === 'publish' ? 'Share' : vm.primaryKind === 'disable' ? 'Pause' : 'Play';
  const titlebarRight = (
    <span className={styles.tlBuilderActions}>
      {!vm.isAutomation && (
        <button
          type="button"
          className={chrome.tbBtn}
          aria-label="View history"
          title="View history"
          data-active={String(vm.historyToggleActive)}
          onClick={() => vm.setChatView(vm.chatView === 'history' ? 'chat' : 'history')}
          dangerouslySetInnerHTML={{ __html: iconSvg('History', 14) }}
        />
      )}
      <button
        type="button"
        className={chrome.tbBtn}
        aria-label="More app actions"
        title="More"
        dangerouslySetInnerHTML={{ __html: iconSvg('MoreHoriz', 14) }}
      />
      <button
        type="button"
        className={cx(buttonCss.btn, buttonCss.primary, styles.tlPublish)}
        data-kind={vm.primaryKind}
        disabled={vm.primaryDisabled}
        onClick={vm.handlePrimary}
      >
        <span dangerouslySetInnerHTML={{ __html: iconSvg(primaryGlyph, 11) }} />
        <span>{vm.primaryLabel}</span>
      </button>
    </span>
  );

  // ── Right-pane toolbar ──────────────────────────────────────────────────
  const tabs = vm.isAutomation ? AUTO_TABS : APP_TABS;
  const devicePill = (
    <div className={styles.device}>
      {(
        [
          ['mobile', SmartphoneIcon],
          ['tablet', TabletIcon],
          ['desktop', MonitorIcon],
        ] as const
      ).map(([d, glyph]) => (
        <button
          key={d}
          type="button"
          className={styles.deviceBtn}
          aria-label={d}
          title={`${d[0]!.toUpperCase()}${d.slice(1)} preview`}
          data-active={String(vm.previewDevice === d)}
          onClick={() => vm.setPreviewDevice(d)}
          dangerouslySetInnerHTML={{ __html: glyph }}
        />
      ))}
    </div>
  );
  const urlPill = (
    <div className={styles.url} title={previewInfo?.src}>
      <span className={styles.urlDot} data-state={previewInfo ? 'local' : 'building'} />
      <span className={styles.urlText}>
        {previewInfo ? formatPreviewUrl(previewInfo.src) : 'Building…'}
      </span>
      <button
        type="button"
        className={styles.urlRefresh}
        aria-label="Reload preview"
        title="Reload preview"
        onClick={() => vm.setTab('preview')}
        dangerouslySetInnerHTML={{ __html: RefreshIcon }}
      />
    </div>
  );
  const rbToolbar = (
    <div className={styles.toolbar} data-tab={vm.tab}>
      {urlPill}
      <div className={styles.toolbarSpacer} />
      {devicePill}
      {!vm.isAutomation && (
        <button
          type="button"
          className={styles.toolbarShare}
          aria-label="Open in new tab"
          title="Open in new tab"
          onClick={() => previewInfo && window.open(previewInfo.src, '_blank', 'noopener')}
          dangerouslySetInnerHTML={{ __html: iconSvg('Share', 12) }}
        />
      )}
      <span className={styles.tabsPill}>
        {tabs.map(([key, label, glyph]) => (
          <button
            key={key}
            type="button"
            className={styles.tab}
            aria-label={label}
            title={label}
            data-active={String(vm.tab === key)}
            onClick={() => vm.setTab(key)}
            dangerouslySetInnerHTML={{ __html: iconSvg(glyph, 13) }}
          />
        ))}
      </span>
    </div>
  );

  // ── Right-pane content ──────────────────────────────────────────────────
  let pane: ReactNode;
  if (vm.isAutomation) {
    pane = (
      <BuilderAutomationPane
        tab={vm.tab as 'config' | 'flow' | 'runs' | 'code'}
        appId={vm.automationRow?.ref ?? vm.appId ?? ''}
        automationRow={vm.automationRow}
        flashSections={vm.flashSections}
      />
    );
  } else if (vm.tab === 'code') {
    pane = vm.appId ? <BuilderCode appId={vm.appId} reloadNonce={vm.reloadNonce} /> : null;
  } else if (vm.tab === 'cloud') {
    pane = vm.appId ? <BuilderCloud appId={vm.appId} /> : null;
  } else {
    pane = (
      <BuilderPreview
        appId={vm.appId}
        accentColor={vm.projColor}
        device={vm.previewDevice}
        reloadNonce={vm.reloadNonce}
        onResolved={setPreviewInfo}
      />
    );
  }

  const rightPaneClass = cx(
    rightPaneCss.pane,
    !vm.isAutomation && vm.tab === 'preview' && vm.previewDevice !== 'desktop' && styles.hasPhone,
  );

  return (
    <ShellFrame
      sidebarOpen={prefs.sidebarOpen}
      onToggleSidebar={onToggleSidebar}
      sidebar={renderSidebar(nav)}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      showNewChat
      onNewChat={() => nav.navigate({ kind: 'home' })}
      showChatToggle
      chatPaneOpen={chatVisible}
      onToggleChat={toggleChat}
      titlebarLead={titlebarLead}
      titlebarRight={titlebarRight}
    >
      <div className={styles.builder} data-chat={chatVisible ? 'open' : 'closed'}>
        <div className={styles.builderBody}>
          <div className={styles.chatPane}>
            <BuilderChatPane
              onReady={(u) => vm.registerChatUpdater(u)}
              onSend={(t, atts) => vm.sendUserPrompt(t, atts)}
              {...(vm.appId ? { onUploadAttachment: (f: File) => vm.uploadChatAttachment(f) } : {})}
              onCancel={() => vm.cancelTurn()}
              onToggleGroup={(id) => vm.toggleGroup(id)}
              onSetView={(v) => vm.setChatView(v)}
              onMountHistory={(host) => {
                historyRoots.current.get(host)?.unmount();
                const root = createRoot(host);
                root.render(
                  <BuilderHistory
                    appId={vm.appId}
                    onRestored={(id) => vm.onRestored(id)}
                    showToast={showToast}
                  />,
                );
                historyRoots.current.set(host, root);
              }}
            />
          </div>
          <div className={rightPaneClass}>
            {rbToolbar}
            <div className={styles.rightPaneContent}>{pane}</div>
          </div>
        </div>
      </div>
    </ShellFrame>
  );
}
