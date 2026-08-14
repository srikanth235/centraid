import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { AppearancePrefs } from "../../../../app-shell-context.js";
import BuilderChatPane from "../../../screens/BuilderChatPane.js";
import { cx } from "../../../ui/cx.js";
import { useShellActions } from "../../actions.js";
import { iconSvg } from "../../iconSvg.js";
import type { ShellNav } from "../../ShellApp.js";
import ShellFrame from "../../ShellFrame.js";
import { Store } from "../../store.js";
import BuilderAutomationPane from "./BuilderAutomationPane.js";
import BuilderCloud from "./BuilderCloud.js";
import BuilderCode from "./BuilderCode.js";
import BuilderHistory from "./BuilderHistory.js";
import type { Tab } from "./builderModel.js";
import BuilderPreview from "./BuilderPreview.js";
import { useBuilder } from "./useBuilder.js";
import type { UseBuilderInput } from "./useBuilder.js";

import buttonCss from "../../../ui/Button.module.css";
import chrome from "../../chrome.module.css";
import styles from "./BuilderShell.module.css";
import rightPaneCss from "./rightPane.module.css";

// Inline device/reload glyphs (mirror builder.ts) — not in the design-token set.
const SmartphoneIcon =
  '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
const TabletIcon =
  '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
const MonitorIcon =
  '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>';
const RefreshIcon =
  '<svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>';

const APP_TABS: [Tab, string, string][] = [
  ["preview", "Preview", "Eye"],
  ["code", "Code", "Code"],
  ["cloud", "Cloud", "Bolt"],
];
const AUTO_TABS: [Tab, string, string][] = [
  ["config", "Config", "Settings"],
  ["flow", "Flow", "Activity"],
  ["runs", "Runs", "History"],
  ["code", "Code", "Code"],
];

function formatPreviewUrl(src: string): string {
  try {
    const u = new URL(src);
    if (u.pathname.includes("/_draft/")) return "Draft preview";
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return src;
  }
}

const CHAT_PANE_PREF = "builder.chatPaneOpen";

/** Character width for the rename input, clamped to the old lockup's range. */
function nameSize(name: string): number {
  return Math.min(24, Math.max(4, name.length));
}

function mountBuilderHistory(
  host: HTMLElement,
  roots: Map<HTMLElement, Root>,
  appId: string,
  onRestored: (id: string) => void,
  showToast: (message: string) => void
): void {
  roots.get(host)?.unmount();
  const root = createRoot(host);
  root.render(
    <BuilderHistory
      appId={appId}
      onRestored={onRestored}
      showToast={showToast}
    />
  );
  roots.set(host, root);
}

export interface BuilderShellProps extends UseBuilderInput {
  nav: ShellNav;
  renderStem: (nav: ShellNav) => ReactNode;
  /** The frame's one status line — full-bleed hosts mount their own frame,
   *  so they are handed the same node rather than inheriting it. */
  statusLine?: ReactNode;
  prefs: AppearancePrefs;
}

export default function BuilderShell(props: BuilderShellProps): JSX.Element {
  const { nav, renderStem, statusLine, ...builderInput } = props;
  const { showToast } = useShellActions();
  const vm = useBuilder(builderInput);

  const [chatOpenPref, setChatOpenPref] = useState<boolean>(() =>
    Store.get<boolean>(CHAT_PANE_PREF, true)
  );
  const [previewInfo, setPreviewInfo] = useState<{ src: string } | null>(null);

  // Name lockup: set the value imperatively so React never clobbers a mid-edit
  // caret. `size` is the input's own shrink-to-fit knob (an inline <b> sized
  // itself; a text input does not), clamped so the titlebar never jumps.
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (nameRef.current && nameRef.current.value !== vm.projName) {
      nameRef.current.value = vm.projName;
      nameRef.current.size = nameSize(vm.projName);
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
  const chatEligible = vm.isAutomation || vm.tab === "preview";
  const chatVisible = chatEligible && chatOpenPref;
  const toggleChat = useCallback((): void => {
    if (!chatEligible) return;
    setChatOpenPref((open) => {
      const next = !open;
      Store.set(CHAT_PANE_PREF, next);
      return next;
    });
  }, [chatEligible]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== "\\") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      toggleChat();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [chatEligible, toggleChat]);

  const finish = window.CentraidTokens.tileFinish(vm.projColor, "gradient");

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
        // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
        dangerouslySetInnerHTML={{
          __html: iconSvg(vm.projIcon || "Sparkle", 11, 1.9),
        }}
      />
      {/* The rename field is a text field, so it is a real <input> — a
          contenteditable <b> claiming `role="textbox"` was neither, and it
          stopped being focusable at all for automations (whose name is not
          editable, and which render as static text). `size` tracks the value
          so the box still shrinks to the name the way the old inline element
          did; it is set imperatively for the same reason the text was — React
          must never re-render a mid-edit caret away. */}
      {vm.isAutomation ? (
        <b>{vm.projName}</b>
      ) : (
        <input
          ref={nameRef}
          type="text"
          aria-label="App name"
          defaultValue={vm.projName}
          size={nameSize(vm.projName)}
          spellCheck={false}
          title="Click to rename"
          onInput={(e) => {
            e.currentTarget.size = nameSize(e.currentTarget.value);
          }}
          onBlur={(e) => vm.commitRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.value = vm.projName;
              e.currentTarget.size = nameSize(vm.projName);
              e.currentTarget.blur();
            }
          }}
        />
      )}
      <span className={styles.tlStatus} data-state={vm.statusState}>
        <span className={styles.tlStatusDot} />
        <span>{vm.statusText}</span>
      </span>
    </span>
  );

  // ── Titlebar right: history, more, primary ──────────────────────────────
  const primaryGlyph =
    vm.primaryKind === "publish"
      ? "Share"
      : vm.primaryKind === "disable"
        ? "Pause"
        : "Play";
  const titlebarRight = (
    <span className={styles.tlBuilderActions}>
      {!vm.isAutomation && (
        <button
          type="button"
          className={chrome.tbBtn}
          aria-label="View history"
          title="View history"
          data-active={String(vm.historyToggleActive)}
          onClick={() =>
            vm.setChatView(vm.chatView === "history" ? "chat" : "history")
          }
          // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
          dangerouslySetInnerHTML={{ __html: iconSvg("History", 14) }}
        />
      )}
      <button
        type="button"
        className={chrome.tbBtn}
        aria-label="More app actions"
        title="More"
        // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
        dangerouslySetInnerHTML={{ __html: iconSvg("MoreHoriz", 14) }}
      />
      <button
        type="button"
        className={cx(buttonCss.btn, buttonCss.primary, styles.tlPublish)}
        data-testid="builder-publish"
        data-kind={vm.primaryKind}
        disabled={vm.primaryDisabled}
        onClick={vm.handlePrimary}
      >
        <span
          // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
          dangerouslySetInnerHTML={{ __html: iconSvg(primaryGlyph, 11) }}
        />
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
          ["mobile", SmartphoneIcon],
          ["tablet", TabletIcon],
          ["desktop", MonitorIcon],
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
          // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
          dangerouslySetInnerHTML={{ __html: glyph }}
        />
      ))}
    </div>
  );
  const urlPill = (
    <div className={styles.url} title={previewInfo?.src}>
      <span
        className={styles.urlDot}
        data-state={previewInfo ? "local" : "building"}
      />
      <span className={styles.urlText}>
        {previewInfo ? formatPreviewUrl(previewInfo.src) : "Building…"}
      </span>
      <button
        type="button"
        className={styles.urlRefresh}
        aria-label="Reload preview"
        title="Reload preview"
        onClick={() => vm.setTab("preview")}
        // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
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
          onClick={() =>
            previewInfo && window.open(previewInfo.src, "_blank", "noopener")
          }
          // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
          dangerouslySetInnerHTML={{ __html: iconSvg("Share", 12) }}
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
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
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
        tab={vm.tab as "config" | "flow" | "runs" | "code"}
        appId={vm.automationRow?.ref ?? vm.appId ?? ""}
        automationRow={vm.automationRow}
        flashSections={vm.flashSections}
      />
    );
  } else if (vm.tab === "code") {
    pane = vm.appId ? (
      <BuilderCode appId={vm.appId} reloadNonce={vm.reloadNonce} />
    ) : null;
  } else if (vm.tab === "cloud") {
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
    !vm.isAutomation &&
      vm.tab === "preview" &&
      vm.previewDevice !== "desktop" &&
      styles.hasPhone
  );
  const handleToggleStem = nav.toggleStem;

  return (
    <ShellFrame
      stem={renderStem(nav)}
      onToggleStem={handleToggleStem}
      stemOpen={nav.stemOpen}
      statusLine={statusLine}
      canGoBack={nav.canGoBack}
      canGoForward={nav.canGoForward}
      onBack={() => nav.back()}
      onForward={() => nav.forward()}
      showNewChat
      onNewChat={() => nav.navigate({ kind: "home" })}
      assistantOpen={nav.assistantOpen}
      {...(nav.toggleAssistant
        ? { onToggleAssistant: nav.toggleAssistant }
        : {})}
      showChatToggle
      chatPaneOpen={chatVisible}
      onToggleChat={toggleChat}
      titlebarLead={titlebarLead}
      titlebarRight={titlebarRight}
    >
      <div
        className={styles.builder}
        data-chat={chatVisible ? "open" : "closed"}
      >
        <div className={styles.builderBody} data-testid="builder-body">
          <div className={styles.chatPane}>
            <BuilderChatPane
              onReady={(u) => vm.registerChatUpdater(u)}
              onSend={(t, atts) => vm.sendUserPrompt(t, atts)}
              {...(vm.appId
                ? {
                    onUploadAttachment: (f: File) => vm.uploadChatAttachment(f),
                  }
                : {})}
              onCancel={() => vm.cancelTurn()}
              onToggleGroup={(id) => vm.toggleGroup(id)}
              onSetView={(v) => vm.setChatView(v)}
              onSetWorkspaceKind={(kind) => vm.setChatWorkspaceKind(kind)}
              onSetHarness={(kind) => vm.setChatHarness(kind)}
              onSetModel={(model) => vm.setChatModel(model)}
              onSetEffort={(effort) => vm.setChatEffort(effort)}
              onMountHistory={(host) => {
                if (vm.appId) {
                  mountBuilderHistory(
                    host,
                    historyRoots.current,
                    vm.appId,
                    vm.onRestored,
                    showToast
                  );
                }
              }}
            />
          </div>
          <div className={rightPaneClass}>
            {rbToolbar}
            <div
              className={styles.rightPaneContent}
              data-testid="builder-right-pane"
            >
              {pane}
            </div>
          </div>
        </div>
      </div>
    </ShellFrame>
  );
}
