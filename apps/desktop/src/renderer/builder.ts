// Builder mode — chat-driven app generation, wired live to:
//   - the centraid agent (window.CentraidApi.startAgent / promptAgent / onAgentEvent)
//   - the project folder on disk (readProjectFiles for the Code tab)
//   - the openclaw centraid plugin (publish, listVersions, activateVersion)
// governance: allow-repo-hygiene file-size-limit builder-mode pending split into chat/preview/code modules
//
// Layout (modeled on Lovable's IA):
//   Topbar:    [back][project] [history-btn][sidebar-btn] {Preview|Code} [device|URL|↗|⟳] [Share][primary]
//   Chat pane: swaps between live chat (chatView='chat') and version history
//              (chatView='history'). Sidebar-btn collapses the whole pane.
//   Right pane: Preview (iframe → live gateway URL or local centraid-preview://)
//               or Code (project files, syntax-highlighted).

(function () {
  // A single tool invocation. Multiple of these are consolidated into a
  // toolGroup chat bubble (see below).
  type ToolCall = {
    id: string;
    tool: string;
    summary?: string;
    state: 'running' | 'ok' | 'error';
  };

  type ChatMsg =
    | { kind: 'divider'; text: string }
    | { kind: 'status'; text: string; spinning?: boolean }
    | { kind: 'user'; text: string }
    | { kind: 'ai'; text: string; streaming?: boolean }
    | { kind: 'thinking'; text: string; streaming?: boolean }
    // Adjacent tool calls (no AI text or thinking between them) are folded
    // into one toolGroup bubble — a single collapsible pill labelled with a
    // verb-and-count summary like "Reading ×3, Writing". `id` is the first
    // call's toolCallId and serves as a stable identity for click handlers
    // across re-renders.
    | { kind: 'toolGroup'; id: string; calls: ToolCall[]; open: boolean };

  type Tab = 'preview' | 'code' | 'cloud';
  type ChatView = 'chat' | 'history';
  type DeviceKey = 'mobile' | 'tablet' | 'desktop';

  // Inline SVGs for icons not in @centraid/design-tokens. Kept tiny so they
  // can live next to the topbar buttons that need them.
  const RefreshIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>`;
  const SmartphoneIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>`;
  const TabletIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>`;
  const MonitorIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
  // Sparkle glyph for the "Try" follow-up label and other contextual hints.
  // Smaller stroke than the design-token Sparkle so it sits comfortably as a
  // 11px label adornment.
  const SparkleIcon = (size = 11): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.8 4.7L18 9l-4.2 1.3L12 15l-1.8-4.7L6 9l4.2-1.3z"/><path d="M19 15l.6 1.6L21 17l-1.4.4L19 19l-.6-1.6L17 17l1.4-.4z"/></svg>`;
  const FolderOpenIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z"/><path d="M3 9h18l-2 9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  // File-with-edit glyph for the change card that surfaces below tool-group
  // pills when the agent wrote files. Page outline + a small pen overlay.
  const FileEditIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="14 3 14 9 20 9"/><path d="M18 13l3 3-5 5h-3v-3z"/></svg>`;
  // Cloud-tab icons. The Cloud tab is a Lovable-style data-browser panel
  // that lives next to Preview/Code; these glyphs label the tab itself and
  // the left-rail sub-sections (Database, Users, Storage, etc.).
  const CloudIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>`;
  const CloudOverviewIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`;
  const DatabaseIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/><path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/></svg>`;
  const UsersIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const StorageIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><line x1="7" y1="7" x2="7.01" y2="7"/><line x1="7" y1="17" x2="7.01" y2="17"/></svg>`;
  const SecretsIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 9.65-9.65"/><path d="m18 5 3 3"/><path d="m15 8 3 3"/></svg>`;
  const FunctionsIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H6a2 2 0 0 0-2 2v3"/><path d="M4 15v3a2 2 0 0 0 2 2h3"/><path d="M15 4h3a2 2 0 0 1 2 2v3"/><path d="M20 15v3a2 2 0 0 1-2 2h-3"/><path d="M10 9c1 0 1 .5 1 1.5S10.5 12 11 13s2 1.5 2 1.5"/></svg>`;
  const SqlIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 8 9 12 5 16"/><line x1="13" y1="16" x2="19" y2="16"/></svg>`;
  const LogsIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`;
  // Tool-group icons. Bolt = activity glyph on the consolidated pill;
  // ChevronDownIcon = expand/collapse affordance (rotates 180° when open).
  const BoltIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>`;
  const ChevronDownIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
  // File-tree icons (used by the Code view).
  const ChevronIcon = (size = 12): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  const FolderIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`;
  const Api = (): Window['CentraidApi'] => window.CentraidApi;

  function escapeHtml(s: string): string {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function tokenize(
    src: string,
    lang: 'html' | 'js' | 'ts' | 'css' | 'json' | 'md' | 'other',
  ): string {
    // Each pass below wraps tokens in placeholder control chars instead of
    // real <span> markup. Without this, a later regex can match the literal
    // text of an earlier injection — e.g. `\s[\w-]+=` happily eats the
    // ` class=` inside an inserted `<span class="tok-tag">`, leaking class
    // names into the rendered code view. We swap placeholders → spans only
    // at the very end, after all passes have run.
    const TAG = '\x01';
    const ATTR = '\x02';
    const STR = '\x03';
    const KEY = '\x04';
    const COM = '\x05';
    const END = '\x06';
    let html = escapeHtml(src);
    if (lang === 'html') {
      html = html
        .replaceAll(/(&lt;\/?[\w-]+)/g, `${TAG}$1${END}`)
        .replaceAll(/(\s[\w-]+)=/g, `${ATTR}$1${END}=`)
        .replaceAll(/("[^"]*")/g, `${STR}$1${END}`);
    } else if (lang === 'js' || lang === 'ts') {
      html = html
        .replaceAll(/\/\/[^\n]*/g, (m) => `${COM}${m}${END}`)
        .replaceAll(
          /\b(const|let|var|function|return|if|else|for|new|try|catch|throw|async|await|export|import|from|type|interface|class|extends|implements|satisfies)\b/g,
          `${KEY}$1${END}`,
        )
        .replaceAll(/('[^']*'|"[^"]*"|`[^`]*`)/g, `${STR}$1${END}`);
    } else if (lang === 'css') {
      html = html
        .replaceAll(/(\/\*[\s\S]*?\*\/)/g, `${COM}$1${END}`)
        .replaceAll(/(--[\w-]+)/g, `${KEY}$1${END}`)
        .replaceAll(/(#[0-9a-f]{3,8}|\d+px|\d+%)/g, `${STR}$1${END}`);
    } else if (lang === 'json') {
      html = html
        .replaceAll(/("[^"]*")(\s*:)/g, `${ATTR}$1${END}$2`)
        .replaceAll(/:\s*("[^"]*")/g, `: ${STR}$1${END}`)
        .replaceAll(/\b(true|false|null)\b/g, `${KEY}$1${END}`);
    }
    return html
      .replaceAll(TAG, '<span class="tok-tag">')
      .replaceAll(ATTR, '<span class="tok-attr">')
      .replaceAll(STR, '<span class="tok-str">')
      .replaceAll(KEY, '<span class="tok-key">')
      .replaceAll(COM, '<span class="tok-com">')
      .replaceAll(END, '</span>');
  }

  function languageHint(p: string): 'html' | 'js' | 'ts' | 'css' | 'json' | 'md' | 'other' {
    if (p.endsWith('.ts')) return 'ts';
    if (p.endsWith('.js') || p.endsWith('.mjs')) return 'js';
    if (p.endsWith('.html') || p.endsWith('.htm')) return 'html';
    if (p.endsWith('.css')) return 'css';
    if (p.endsWith('.json')) return 'json';
    if (p.endsWith('.md')) return 'md';
    return 'other';
  }

  function slugify(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
  }

  function generateProjectId(seed: string): string {
    const slug = slugify(seed) || 'app';
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${slug}-${suffix}`;
  }

  function relativeWhen(iso: string): string {
    try {
      const t = new Date(iso).getTime();
      const ms = Date.now() - t;
      const s = Math.floor(ms / 1000);
      if (s < 60) return 'Just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      if (d < 30) return `${d}d ago`;
      return new Date(iso).toLocaleDateString();
    } catch {
      return iso;
    }
  }

  // Per-language label shown in the colored pill next to a filename in the
  // Code view. Kept tiny + uppercase to read as metadata, not a brand mark.
  const LANG_DISPLAY: Record<'html' | 'js' | 'ts' | 'css' | 'json' | 'md' | 'other', string> = {
    html: 'HTML',
    js: 'JS',
    ts: 'TS',
    css: 'CSS',
    json: 'JSON',
    md: 'MD',
    other: 'TXT',
  };

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function shortVersionTitle(v: { versionId: string; declaredVersion?: string }): string {
    if (v.declaredVersion) return v.declaredVersion;
    // versionId looks like v_2026-05-08T14-30-00-000Z_a1b2c3
    const m = /v_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})-/.exec(v.versionId);
    return m ? m[1]!.replace('T', ' ') : v.versionId.slice(0, 24);
  }

  function openBuilder(opts: BuilderOptions): () => void {
    const { root, el, onExit, initialPrompt, appContext, onAddToHome, onMetaChange } = opts;

    const isUpdateMode = !!opts.projectId;
    const isNewBuild = !isUpdateMode && !!initialPrompt;
    let projName = appContext?.name || (isNewBuild ? 'New app' : 'Untitled');
    // Description still rides on app.json — the inline editor was removed
    // when the subtitle slot became the read-only status row. The value
    // continues to surface via appContext.desc to the home grid.
    const projColor = appContext?.color || (window.ICON_PALETTE?.rose ?? '#5847e0');
    const projIcon: IconNameType = appContext?.iconKey || 'Sparkle';

    // ---------- State ----------
    let projectId: string | undefined = opts.projectId;
    let chat: ChatMsg[] = [];
    let tab: Tab = 'preview';
    let chatView = 'chat' as ChatView;
    let previewDevice = 'mobile' as DeviceKey;
    let generating = false;
    let publishing = false;
    let lastPublishedVersionId: string | undefined;
    let unsubscribeAgent: (() => void) | null = null;
    let liveUrl: string | undefined;
    // Cloud → Logs polling handle. Hoisted out of renderCloud's closure so
    // that any code that tears down the right pane (renderRight, builder
    // unmount, tab switch) can stop the poll regardless of which renderCloud
    // call started it.
    let cloudLogsPoll: ReturnType<typeof setInterval> | undefined;
    const stopCloudLogsPoll = (): void => {
      if (cloudLogsPoll) {
        clearInterval(cloudLogsPoll);
        cloudLogsPoll = undefined;
      }
    };
    let currentAiMsgIndex = -1; // index in `chat` of the streaming AI bubble
    let currentThinkingMsgIndex = -1; // index of the streaming thinking block
    let pendingToolStarts = new Map<string, number>(); // toolCallId → chat index
    // Set by tool_execution_end when the agent writes/edits a file in the
    // project. Consumed by turn_end to refresh the preview iframe so the
    // user sees their changes without manually reloading.
    let previewReloadPending = false;
    const FILE_WRITING_TOOLS = new Set(['write', 'edit', 'multi_edit']);

    // Verb form of a tool name, used as the pill label and per-row name.
    // Falls back to a capitalised tool key for anything we don't have a verb
    // for so unknown tools still read sensibly.
    function toolVerb(tool: string): string {
      switch (tool) {
        case 'read':
          return 'Reading';
        case 'write':
          return 'Writing';
        case 'edit':
        case 'multi_edit':
          return 'Editing';
        case 'bash':
          return 'Running';
        case 'glob':
          return 'Listing';
        case 'grep':
          return 'Searching';
        default:
          return tool.charAt(0).toUpperCase() + tool.slice(1);
      }
    }

    // Build the consolidated pill label. Adjacent calls with the same verb
    // collapse into "Verb ×N"; distinct verbs are joined by commas. Mirrors
    // the design system's `tcg-pill` examples like "Reading ×3, Writing".
    function summarizeGroup(calls: ToolCall[]): string {
      const segs: { verb: string; count: number }[] = [];
      for (const c of calls) {
        const verb = toolVerb(c.tool);
        const last = segs[segs.length - 1];
        if (last && last.verb === verb) last.count += 1;
        else segs.push({ verb, count: 1 });
      }
      return segs.map((s) => (s.count > 1 ? `${s.verb} ×${s.count}` : s.verb)).join(', ');
    }

    // Build a one-line, human-readable summary of a tool call's args.
    // Mirrors the fields pi's built-in tools actually emit (path / command /
    // pattern). Falls back gracefully for custom or unknown tools.
    function summarizeToolArgs(tool: string, args: unknown): string | undefined {
      if (!args || typeof args !== 'object') return undefined;
      const a = args as Record<string, unknown>;
      const pickStr = (...keys: string[]): string | undefined => {
        for (const k of keys) {
          const v = a[k];
          if (typeof v === 'string' && v.length > 0) return v;
        }
        return undefined;
      };
      const truncate = (s: string, n: number): string =>
        s.length > n ? s.slice(0, n - 1) + '…' : s;

      switch (tool) {
        case 'read':
        case 'write':
        case 'edit':
        case 'multi_edit':
          return pickStr('path', 'file_path');
        case 'bash': {
          const cmd = pickStr('command');
          return cmd ? truncate(cmd.replace(/\s+/g, ' ').trim(), 90) : undefined;
        }
        case 'glob':
        case 'grep': {
          const pattern = pickStr('pattern', 'query');
          const path = pickStr('path');
          if (pattern && path) return `${pattern}  in  ${path}`;
          return pattern ?? path;
        }
        default:
          // Best-effort: pick the first short-ish string field.
          for (const k of ['path', 'file_path', 'command', 'pattern', 'query', 'name', 'id']) {
            const v = a[k];
            if (typeof v === 'string' && v.length > 0) return truncate(v, 90);
          }
          return undefined;
      }
    }

    // ---------- Top bars ----------
    // The old `.titlebar` breadcrumb is replaced by the cd-window chrome
    // (built at mount time, below). `crumbProjName` is kept as a no-op span
    // so existing callers that update its textContent on rename still work.
    const crumbProjName = el('span', {}, isUpdateMode ? `Editing ${projName}` : 'Builder');

    const primaryBtn = el('button', { class: 'btn btn-primary' });
    primaryBtn.innerHTML = Icon.Plus({ size: 13 }) + '<span>Add to home</span>';
    primaryBtn.addEventListener('click', () => {
      void handlePublish();
    });
    if (isUpdateMode) {
      // Update mode reuses the publish flow; the label reflects the gateway
      // semantics (this uploads a new version) rather than implying a
      // local-only save.
      primaryBtn.innerHTML = (Icon.Save ? Icon.Save({ size: 13 }) : '') + '<span>Publish</span>';
    }

    const projIconEl = el('div', {
      class: 'app-topbar-icon',
      trustedHtml: (Icon[projIcon] || Icon.Sparkle)({ size: 14, strokeWidth: 2 }),
      style: {
        background: projColor as string,
        borderRadius: '4px',
        height: '28px',
        width: '28px',
      },
    });

    // Read-only status row that replaces the old editable description
    // subtitle (which was 'Built with Centraid.' / 'Add a description…').
    // Mirrors the v2 mockup's `● Live · v3 · edited 14h ago` pattern: a
    // colored dot reflects the sync state (driven by `[data-state]` set
    // by paintStatus), followed by version number + relative edit time
    // when known. For a draft project the row just reads 'Draft'. The
    // description data is preserved in app.json — editing moves to a
    // future settings affordance.
    const projStatusDot = el('span', { class: 'cd-app-strip-status-dot' });
    const projStatusText = el('span', { class: 'cd-app-strip-status-text' }, 'Draft');
    const projSubtitleEl = el(
      'span',
      { 'data-state': 'idle-draft', class: 'cd-app-strip-status' },
      [projStatusDot, projStatusText],
    );
    let appVersionCount = 0;
    let appLastEditedAt: number | undefined;
    function relTime(ts: number): string {
      const diff = Math.max(0, Date.now() - ts);
      if (diff < 60_000) return 'just now';
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
      if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
      return `${Math.floor(diff / 86_400_000)}d ago`;
    }
    function parseVersionTime(versionId: string): number | undefined {
      // Version IDs come back from the gateway as `v_YYYY-MM-DDTHH-MM-...`
      // so we can parse the embedded ISO timestamp without a separate
      // gateway call.
      const m = versionId.match(/^v_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
      if (!m) return undefined;
      return Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`);
    }
    function paintStatus(): void {
      // Status text composition is driven by sync state (publishing /
      // editing / live / draft) plus version + edit-time facts. The dot
      // colour is owned by the parent's [data-state] attribute, set by
      // refreshSyncStatus().
      let text: string;
      if (publishing) {
        text = 'Publishing…';
      } else if (generating) {
        text = 'Editing…';
      } else if (lastPublishedVersionId) {
        const parts = ['Live'];
        if (appVersionCount > 0) parts.push(`v${appVersionCount}`);
        if (appLastEditedAt) parts.push(`edited ${relTime(appLastEditedAt)}`);
        text = parts.join(' · ');
      } else {
        text = 'Draft';
      }
      projStatusText.textContent = text;
    }
    paintStatus();

    // Mode tabs render as icon-only pills by default; the active tab expands
    // to icon+label (Lovable pattern). Each entry's third field is a render
    // fn so we can mix design-token icons (Eye, Code) with inline SVGs (Cloud).
    const tabDefs: [Tab, string, () => string][] = [
      ['preview', 'Preview', () => Icon.Eye({ size: 13 })],
      ['code', 'Code', () => Icon.Code({ size: 13 })],
      ['cloud', 'Cloud', () => CloudIcon(13)],
    ];

    // History toggle — swaps the chat pane between live chat and version
    // history (matches Lovable; keeps the right pane on Preview/Code so the
    // user can still see the rendered app while browsing past versions).
    const historyBtn = el('button', {
      'aria-label': 'View history',
      class: 'topbar-icon-btn',
      'data-active': String(chatView === 'history'),
      trustedHtml: Icon.History({ size: 16 }),
      title: 'View history',
      onClick: () => {
        chatView = chatView === 'history' ? 'chat' : 'history';
        renderChatPane();
        refreshTopbarToggles();
      },
    });

    // The window chrome (cd-tl-main) owns its own sidebar toggle — the
    // duplicate in the old cd-app-strip is gone with the strip itself.
    // `sidebarOpen` is now flipped via Chrome.setSidebarOpen.

    // Device segmented control — toggles the preview iframe between
    // mobile / tablet / desktop framing. Lives in the right-pane toolbar
    // and is hidden when the active tab isn't Preview (via .urlbar-slot
    // data-visible). The old URL address bar that used to sit beside it
    // has been removed — the preview iframe is the source of truth.
    const deviceMobileBtn = el('button', {
      'aria-label': 'Mobile',
      class: 'urlbar-device-btn',
      'data-active': String(previewDevice === 'mobile'),
      title: 'Mobile preview',
      // Icon + visible label (Phone / Tablet / Desktop) — matches the
      // v2 mockup's segmented device pill instead of icon-only.
      trustedHtml: `${SmartphoneIcon(13)}<span class="urlbar-device-label">Phone</span>`,
      onClick: () => {
        if (previewDevice === 'mobile') return;
        previewDevice = 'mobile';
        if (tab === 'preview') renderRight();
        refreshTopbarToggles();
      },
    });
    const deviceTabletBtn = el('button', {
      'aria-label': 'Tablet',
      class: 'urlbar-device-btn',
      'data-active': String(previewDevice === 'tablet'),
      title: 'Tablet preview',
      trustedHtml: `${TabletIcon(13)}<span class="urlbar-device-label">Tablet</span>`,
      onClick: () => {
        if (previewDevice === 'tablet') return;
        previewDevice = 'tablet';
        if (tab === 'preview') renderRight();
        refreshTopbarToggles();
      },
    });
    const deviceDesktopBtn = el('button', {
      'aria-label': 'Desktop',
      class: 'urlbar-device-btn',
      'data-active': String(previewDevice === 'desktop'),
      title: 'Desktop preview',
      trustedHtml: `${MonitorIcon(13)}<span class="urlbar-device-label">Desktop</span>`,
      onClick: () => {
        if (previewDevice === 'desktop') return;
        previewDevice = 'desktop';
        if (tab === 'preview') renderRight();
        refreshTopbarToggles();
      },
    });
    const devicePill = el('div', { class: 'urlbar-device' }, [
      deviceMobileBtn,
      deviceTabletBtn,
      deviceDesktopBtn,
    ]);
    const urlbarSlot = el('div', { class: 'urlbar-slot' }, [devicePill]);

    // Inline-editable title + description. Edits persist to
    // `app.json#{name,description}` via the updateProjectMeta IPC and also
    // fire `onMetaChange` so the home pane can refresh its tile metadata
    // without waiting for a re-publish. In new-build mode no project file
    // exists yet, so we only update local state — `createProject` picks up
    // the latest values when the first prompt is sent.
    const projNameEl = el(
      'b',
      { contenteditable: 'plaintext-only', spellcheck: 'false' },
      projName,
    );
    projNameEl.setAttribute('title', 'Click to rename');
    function commitProjNameEdit(): void {
      const next = (projNameEl.textContent ?? '').trim();
      if (!next || next === projName) {
        projNameEl.textContent = projName; // revert empty / no-op
        return;
      }
      const previous = projName;
      projName = next;
      projNameEl.textContent = next;
      crumbProjName.textContent = isUpdateMode ? `Editing ${next}` : 'Builder';
      if (projectId) {
        void Api()
          .updateProjectMeta({ id: projectId, name: next })
          .catch((err: unknown) => {
            // Roll back if persistence fails so the UI stays truthful.
            projName = previous;
            projNameEl.textContent = previous;
            crumbProjName.textContent = isUpdateMode ? `Editing ${previous}` : 'Builder';
            showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        if (onMetaChange) onMetaChange({ projectId, name: next });
      }
    }
    projNameEl.addEventListener('blur', commitProjNameEdit);
    projNameEl.addEventListener('keydown', (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter') {
        ke.preventDefault();
        projNameEl.blur();
      } else if (ke.key === 'Escape') {
        ke.preventDefault();
        projNameEl.textContent = projName;
        projNameEl.blur();
      }
    });

    // Description editing was previously bound to the inline subtitle slot.
    // That slot now shows a read-only sync/version status row, so the
    // editor moves out of the inline meta and will live in a future
    // settings affordance. The description data still rides on app.json
    // and is exposed via `appContext.desc` to the home grid.

    // Tab buttons live inside a cd-tabs-pill so they sit in the titlebar
    // alongside Share/Publish. The buttons keep their existing .mode-tab
    // class so the legacy active/inactive styles still apply.
    const tabsPill = el(
      'span',
      { class: 'cd-tabs-pill' },
      tabDefs.map(([key, label, renderIcon]) => {
        const btn = el('button', {
          'aria-label': label,
          class: 'mode-tab',
          'data-active': String(tab === key),
          title: label,
          onClick: () => {
            tab = key;
            renderRight();
            refreshTabs();
            refreshTopbarToggles();
          },
        });
        btn.innerHTML = `${renderIcon()}<span>${label}</span>`;
        return btn;
      }),
    );

    // Single canonical sync signal — drives the dot colour + label inside
    // the in-pane builder header status row. paintStatus() composes the
    // label from publishing / generating / lastPublishedVersionId + the
    // version count + relative edit time, so version facts compose with
    // sync state in one place.
    function refreshSyncStatus(): void {
      let state: 'editing' | 'publishing' | 'idle-live' | 'idle-draft' = 'idle-draft';
      if (publishing) state = 'publishing';
      else if (generating) state = 'editing';
      else if (lastPublishedVersionId) state = 'idle-live';
      projSubtitleEl.dataset.state = state;
      paintStatus();
    }

    // In-pane builder header — lives at the top of the chat pane and owns
    // the project-level affordances (icon, name, status, more menu, Publish).
    // Project identity belongs to the chat pane (its conversation), not the
    // global window chrome; the chrome row only carries view-context controls
    // (mode tabs, device pill).
    const moreBtn = el('button', {
      'aria-label': 'More project actions',
      class: 'builder-pane-more',
      title: 'More',
      // Wired in a future commit (Share, Rename, Edit description, etc.);
      // for now it's a visual placeholder so the header reads complete.
      trustedHtml:
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
    });
    const builderHeader = el('div', { class: 'builder-pane-header' }, [
      projIconEl,
      el('span', { class: 'builder-pane-meta' }, [projNameEl, projSubtitleEl]),
      el('span', { class: 'builder-pane-actions' }, [historyBtn, moreBtn, primaryBtn]),
    ]);

    function refreshTabs(): void {
      const keys: Tab[] = tabDefs.map(([k]) => k);
      tabsPill.querySelectorAll('.mode-tab').forEach((b, i) => {
        (b as HTMLElement).dataset.active = String(tab === keys[i]);
      });
    }

    // Keep the topbar toggle buttons (history, sidebar, device) and URL-bar
    // visibility in sync with state. Called whenever any of those changes.
    function refreshTopbarToggles(): void {
      historyBtn.dataset.active = String(chatView === 'history');
      deviceMobileBtn.dataset.active = String(previewDevice === 'mobile');
      deviceTabletBtn.dataset.active = String(previewDevice === 'tablet');
      deviceDesktopBtn.dataset.active = String(previewDevice === 'desktop');
      urlbarSlot.dataset.visible = String(tab === 'preview');
    }

    // Trim noisy URL prefixes for display while preserving the full URL on
    // hover (set as title attr by the caller). centraid-preview:// gets
    // shortened to "/<id>/<file>".
    function formatPreviewUrl(src: string): string {
      try {
        const u = new URL(src);
        if (u.protocol === 'centraid-preview:') {
          return (u.pathname || '/').replace(/^\/+/, '/');
        }
        return u.host + (u.pathname === '/' ? '' : u.pathname);
      } catch {
        return src;
      }
    }

    function showToast(text: string): void {
      const existing = body.querySelector('.preview-toast');
      if (existing) existing.remove();
      const toast = el('div', {
        class: 'preview-toast',
        trustedHtml:
          Icon.Check({ size: 13, strokeWidth: 2.5 }) + ` <span>${escapeHtml(text)}</span>`,
      });
      body.append(toast);
      setTimeout(() => toast.remove(), 2400);
    }

    function showActionToast(text: string, actionLabel: string, onAction: () => void): void {
      const existing = body.querySelector('.preview-toast');
      if (existing) existing.remove();
      const toast = el('div', { class: 'preview-toast preview-toast-action' });
      const iconHost = el('span', {
        trustedHtml: Icon.X ? Icon.X({ size: 13, strokeWidth: 2.5 }) : '!',
      });
      const msg = el('span', {}, text);
      const btn = el(
        'button',
        {
          class: 'btn btn-soft tiny-btn',
          onClick: () => {
            toast.remove();
            onAction();
          },
        },
        actionLabel,
      );
      toast.append(iconHost);
      toast.append(msg);
      toast.append(btn);
      body.append(toast);
      // Persist longer; user must engage with it.
      setTimeout(() => toast.remove(), 8000);
    }

    // ---------- Body / panes ----------
    // data-sidebar drives the .builder-body grid columns (open vs collapsed).
    const body = el('div', { class: 'builder-body', 'data-sidebar': 'open' });
    const chatPane = el('div', { class: 'chat-pane' });
    // The right pane is now a flat container for the canvas — the mode
    // tabs + device pill (formerly in `.right-pane-toolbar`) ride in the
    // window chrome row (cd-tl-main) as `titlebarCenter`. Backdrop classes
    // (`preview-pane`, `has-phone`) stay on `rightPane` so the dotted wall
    // fills the column. Render functions write into `rightPaneContent`.
    const rightPane = el('div', { class: 'right-pane' });
    const rightPaneContent = el('div', { class: 'right-pane-content' });
    rightPane.append(rightPaneContent);
    body.append(chatPane);
    body.append(rightPane);

    // Center chrome cluster — tabs (Preview / Code / Cloud) followed by the
    // device pill (Phone / Tablet / Desktop). The device pill hides when
    // the active tab isn't Preview (driven by .urlbar-slot[data-visible]).
    const builderTitlebarCenter = el('span', { class: 'builder-tl-center' }, [
      tabsPill,
      urlbarSlot,
    ]);

    // chat-scroll + chat-input-wrap are recreated by renderChatPane() each
    // time chatView changes, so the same pane can host either view without
    // leaking listeners. We hold references for renderChat() / renderInput().
    let chatScroll: HTMLElement = el('div', { class: 'chat-scroll' });
    let inputWrap: HTMLElement = el('div', { class: 'chat-input-wrap' });

    function renderMessage(m: ChatMsg): HTMLElement {
      if (m.kind === 'divider') {
        return el('div', { class: 'chat-divider' }, [el('span', {}, m.text)]);
      }
      if (m.kind === 'status') {
        return el('div', { class: 'chat-status-row' }, [
          el('span', { class: 'msg-status' }, [
            m.spinning
              ? el('span', { class: 'pulse' })
              : el('span', { trustedHtml: Icon.Check({ size: 12, strokeWidth: 2.5 }) }),
            ' ' + m.text,
          ]),
        ]);
      }
      if (m.kind === 'toolGroup') {
        const groupId = m.id;
        const isRunning = m.calls.some((c) => c.state === 'running');
        const hasError = m.calls.some((c) => c.state === 'error');
        // File-writing calls that completed successfully — these become the
        // "change card" rendered below the pill so the user sees which files
        // changed without expanding the group.
        const writes = m.calls.filter(
          (c) => FILE_WRITING_TOOLS.has(c.tool) && c.state === 'ok' && c.summary,
        );
        const wrap = el('div', {
          class: 'tool-group',
          'data-open': String(m.open),
          'data-running': String(isRunning),
          'data-error': String(hasError),
          'data-has-changes': String(writes.length > 0),
        });
        const pill = el('button', {
          class: 'tool-group-pill',
          type: 'button',
          'aria-expanded': String(m.open),
        });
        // Bolt + label + chevron, in that order, matching the design.
        pill.innerHTML =
          `<span class="tg-bolt">${BoltIcon(13)}</span>` +
          `<span class="tg-label">${escapeHtml(summarizeGroup(m.calls))}</span>` +
          `<span class="tg-chev">${ChevronDownIcon(13)}</span>`;
        pill.addEventListener('click', () => {
          // Re-find by stable id — `m` may be a stale reference after
          // sibling chat updates rebuild the array.
          chat = chat.map((x) =>
            x.kind === 'toolGroup' && x.id === groupId ? { ...x, open: !x.open } : x,
          );
          renderChat();
        });
        wrap.append(pill);
        if (writes.length > 0) {
          // Inline change card. Surfaces "N files updated" with up to three
          // file basenames, so the user sees what shipped without expanding
          // the row-by-row tool list. Clicking the card toggles the group.
          const card = el('button', {
            class: 'tg-change-card',
            type: 'button',
            'aria-label': `${writes.length} file${writes.length === 1 ? '' : 's'} updated — toggle details`,
            onClick: () => {
              chat = chat.map((x) =>
                x.kind === 'toolGroup' && x.id === groupId ? { ...x, open: !x.open } : x,
              );
              renderChat();
            },
          });
          const basenames = writes.map((c) => (c.summary ?? '').split('/').pop() ?? '');
          const shown = basenames.slice(0, 3);
          const moreCount = basenames.length - shown.length;
          const subtitle = shown.join(' · ') + (moreCount > 0 ? ` · +${moreCount} more` : '');
          // Version stamp on the card right edge — gives the user a
          // sense of "what version this lands as" without expanding the
          // tool list. Falls back to "draft" before the first publish.
          const versionLabel = appVersionCount > 0 ? `v${appVersionCount + 1}` : 'draft';
          card.innerHTML =
            `<span class="tg-card-icon">${FileEditIcon(14)}</span>` +
            `<span class="tg-card-meta">` +
            `<span class="tg-card-title">${writes.length} file${writes.length === 1 ? '' : 's'} updated</span>` +
            `<span class="tg-card-sub">${escapeHtml(subtitle)}</span>` +
            `</span>` +
            `<span class="tg-card-version">→ ${escapeHtml(versionLabel)}</span>`;
          wrap.append(card);
        }
        if (m.open) {
          const list = el('div', { class: 'tg-list' });
          for (const c of m.calls) {
            const dot = el('span', { class: 'tg-dot', 'data-state': c.state });
            const name = el('span', { class: 'tg-row-name' }, toolVerb(c.tool));
            const target = el('span', { class: 'tg-row-target' }, c.summary ?? '');
            list.append(el('div', { class: 'tg-row', 'data-state': c.state }, [dot, name, target]));
          }
          wrap.append(list);
        }
        return wrap;
      }
      if (m.kind === 'thinking') {
        const txt = m.text || (m.streaming ? '…' : '');
        return el('div', { class: 'chat-thinking', 'data-streaming': String(!!m.streaming) }, [
          el('div', { class: 'thinking-header' }, [
            el('span', { class: 'thinking-dot' }),
            el('span', {}, m.streaming ? 'Thinking…' : 'Thought'),
          ]),
          el('div', { class: 'thinking-body' }, txt),
        ]);
      }
      if (m.kind === 'user') {
        return el('div', { class: 'msg-user' }, [el('div', { class: 'msg-user-bubble' }, m.text)]);
      }
      // AI message — preserve paragraphs from the streaming text. Lead
      // with a small `builder` author chip (gradient dot + monospace
      // label) that grounds the assistant turn in the conversation
      // rather than letting it read as floating prose.
      const author = el('div', { class: 'msg-ai-author' });
      author.innerHTML =
        '<span class="msg-ai-author-dot"></span><span class="msg-ai-author-name">builder</span>';
      const para = el('div', { class: 'msg-ai-text' });
      const text = m.text || (m.streaming ? '…' : '');
      text.split('\n\n').forEach((p) => para.append(el('p', {}, p)));
      return el('div', { class: 'msg-ai' }, [author, para]);
    }

    function renderChat(): void {
      chatScroll.innerHTML = '';
      for (const m of chat) chatScroll.append(renderMessage(m));
      if (generating && currentAiMsgIndex < 0) {
        chatScroll.append(
          el('div', { class: 'gen-row' }, [
            el('span', { class: 'msg-status' }, [el('span', { class: 'pulse' }), ' Thinking…']),
          ]),
        );
      }
      chatScroll.scrollTop = chatScroll.scrollHeight;
      // The header sync indicator mirrors `generating` — refreshing it
      // here covers every place that toggles the flag (agent events,
      // sendUserPrompt, error paths) without a callback per site.
      refreshSyncStatus();
    }

    function pushMessage(m: ChatMsg): number {
      chat = chat.concat([m]);
      renderChat();
      return chat.length - 1;
    }

    function updateMessage(idx: number, patch: Partial<ChatMsg>): void {
      const at = chat[idx];
      if (!at) return;
      chat = chat.map((m, i) => (i === idx ? ({ ...m, ...patch } as ChatMsg) : m));
      renderChat();
    }

    // ---------- Input ----------
    function renderInput(): void {
      inputWrap.innerHTML = '';
      const ta = el('textarea', {
        placeholder: isUpdateMode ? 'Describe the change…' : 'Ask, or describe what to change…',
        rows: 1,
      }) as HTMLTextAreaElement;

      const send = (): void => {
        const text = ta.value.trim();
        if (!text || generating || !projectId) return;
        ta.value = '';
        void sendUserPrompt(text);
      };
      ta.addEventListener('keydown', (e) => {
        const k = e as KeyboardEvent;
        if (k.key === 'Enter' && !k.shiftKey) {
          k.preventDefault();
          send();
        }
      });

      const sendBtn = el('button', {
        'aria-label': 'Send',
        class: 'send-btn',
        trustedHtml: Icon.Send({ size: 14, strokeWidth: 2.5 }),
        onClick: send,
      });

      const controls = el('div', { class: 'chat-input-controls' }, [
        el('button', {
          'aria-label': 'Attach',
          class: 'input-pill input-pill-icon',
          title: 'Attach',
          trustedHtml: Icon.Plus({ size: 14 }),
        }),
        el('button', {
          'aria-label': 'Open project folder',
          class: 'input-pill input-pill-icon',
          title: 'Open project folder',
          trustedHtml: FolderOpenIcon(14),
          onClick: () => {
            if (projectId) void Api().openProjectFolder({ id: projectId });
          },
        }),
        el('div', { class: 'spacer' }),
        sendBtn,
      ]);

      const wrap = el('div', { class: 'chat-input' }, [ta, controls]);
      // Contextual follow-ups — anchored just above the input, prefixed with
      // a `Try` label so they read as suggestions rather than empty-state
      // filler. Same hardcoded set today; future work can swap in
      // turn-aware suggestions from the agent.
      const followups = el('div', { class: 'prompt-starters' });
      followups.append(
        el('span', {
          class: 'prompt-starters-label',
          trustedHtml: `${SparkleIcon(11)}<span>Try</span>`,
        }),
      );
      for (const suggestion of [
        'Improve the layout',
        'Add saved data',
        'Polish the visual style',
        'Prepare to publish',
      ]) {
        followups.append(
          el(
            'button',
            {
              class: 'prompt-starter',
              onClick: () => {
                ta.value = suggestion;
                ta.focus();
              },
            },
            suggestion,
          ),
        );
      }
      inputWrap.append(followups);
      inputWrap.append(wrap);
    }

    // The chat pane is composed of a persistent header (project icon +
    // name + status + Publish) and a body that swaps between live chat
    // and version history. The header is mounted ONCE during builder
    // setup; renderChatPane only touches the body so the header doesn't
    // flash on every chatView flip.
    const chatBody = el('div', { class: 'chat-body' });
    chatPane.append(builderHeader);
    chatPane.append(chatBody);

    // ---------- Chat pane swap (chat ↔ history) ----------
    function renderChatPane(): void {
      chatBody.innerHTML = '';
      if (chatView === 'history') {
        const head = el('div', { class: 'chatpane-head' }, [
          el('button', {
            'aria-label': 'Back to chat',
            class: 'btn-icon',
            trustedHtml: Icon.ArrowLeft({ size: 14 }),
            onClick: () => {
              chatView = 'chat';
              renderChatPane();
              refreshTopbarToggles();
            },
          }),
          el('span', { class: 'chatpane-head-title' }, 'Version history'),
        ]);
        const list = el('div', { class: 'history-list chatpane-history' });
        chatBody.append(head);
        chatBody.append(list);
        void renderHistoryInto(list);
        return;
      }
      // Default: live chat view. Recreate fresh containers; renderChat /
      // renderInput repopulate them.
      chatScroll = el('div', { class: 'chat-scroll' });
      inputWrap = el('div', { class: 'chat-input-wrap' });
      chatBody.append(chatScroll);
      chatBody.append(inputWrap);
      renderChat();
      renderInput();
    }

    // ---------- Right pane ----------
    function renderRight(): void {
      // Clear only the content area — the toolbar (tabs + URL bar) above
      // it is persistent across renders so the user can switch modes
      // without the toolbar flashing.
      rightPaneContent.innerHTML = '';
      rightPane.classList.remove('preview-pane', 'has-phone');
      // Always stop any in-flight cloud polling before re-rendering; the
      // cloud branch below will restart it if logs is the active section.
      stopCloudLogsPoll();
      if (tab === 'preview') void renderPreview();
      else if (tab === 'cloud') renderCloud();
      else void renderCode();
    }

    // Preview iframes are sandboxed for safety, but `allow-same-origin` is
    // required for the local-files preview to behave like a real page —
    // module imports, fetch to relative paths, and DOM APIs that touch
    // window origin all need it. The published gateway preview gets the
    // same treatment for parity.
    const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-same-origin';

    function makePreviewFrame(src: string): HTMLIFrameElement {
      // Read live theme from the shell (applyPrefs() writes data-theme +
      // --bg-l onto <html>). Preview iframe gets both the initial paint
      // (via #hash, which the inline live-settings bridge in each app's
      // index.html parses on load) and a postMessage on load so the bridge
      // stays in sync — same protocol as the running-app view.
      const html = document.documentElement;
      const theme = html.dataset.theme || 'dark';
      const bgL = (html.style.getPropertyValue('--bg-l') || '5%').replace('%', '').trim();
      const sep = src.includes('#') ? '&' : '#';
      const themedSrc = `${src}${sep}theme=${theme}&bgL=${bgL}`;
      const frame = el('iframe', {
        src: themedSrc,
        style: { border: '0', height: '100%', width: '100%' },
        sandbox: PREVIEW_SANDBOX,
        referrerpolicy: 'no-referrer',
      }) as HTMLIFrameElement;
      // Tagging lets the shell's broadcastSettingsToFrames() find this iframe
      // when the user retunes from Settings while the builder is open.
      frame.dataset.centraidApp = '1';
      frame.addEventListener('load', () => {
        try {
          frame.contentWindow?.postMessage(
            { type: 'centraid:theme', theme, bgL: Number(bgL) },
            '*',
          );
        } catch {
          /* noop */
        }
      });
      return frame;
    }

    async function resolvePreviewSrc(): Promise<
      { src: string; kind: 'live' | 'local' } | undefined
    > {
      if (!projectId) return undefined;
      // Prefer the gateway-served live URL once we know there's a real
      // active version on the gateway (set by bootstrap or handlePublish).
      // We do NOT call appLiveUrl as a probe here — it always succeeds and
      // would falsely point the iframe at a gateway that might not have
      // the app or might not even be running.
      if (liveUrl && lastPublishedVersionId) {
        return { src: liveUrl, kind: 'live' };
      }
      // Local-files fallback: serve <projectsDir>/<id>/index.html via the
      // centraid-preview:// custom protocol registered by the main process.
      try {
        const r = await Api().previewUrl({ id: projectId });
        if (r.available) return { src: r.url, kind: 'local' };
      } catch {
        /* swallow — show empty state below */
      }
      return undefined;
    }

    async function renderPreview(): Promise<void> {
      // `has-phone` styles the pane as the dotted-grid backdrop that mobile
      // and tablet device frames sit on. Desktop wants a plain flex-stretched
      // stage instead, so apply the backdrop conditionally.
      rightPane.classList.add('preview-pane');
      if (previewDevice === 'mobile' || previewDevice === 'tablet') {
        rightPane.classList.add('has-phone');
      }

      const resolved = projectId ? await resolvePreviewSrc() : undefined;

      if (!resolved) {
        const empty = el('div', { class: 'empty' });
        empty.innerHTML = `
          <p><b>Nothing to preview yet.</b></p>
          <p style="margin-top: 6px; opacity: .7">
            The preview shows your app's local files as soon as the agent
            writes an <code>index.html</code>. Click <b>${isNewBuild ? 'Add to home' : 'Save'}</b> to publish to the gateway once you're happy.
          </p>`;
        rightPaneContent.append(empty);
        return;
      }

      const stage = el('div', { class: 'preview-stage' });
      const cardClass =
        previewDevice === 'mobile'
          ? 'preview-card preview-card-mobile'
          : previewDevice === 'tablet'
            ? 'preview-card preview-card-tablet'
            : 'preview-card';
      const card = el('div', { class: cardClass });
      card.style.setProperty('--accent-color', projColor as string);
      card.append(makePreviewFrame(resolved.src));
      stage.append(card);
      rightPaneContent.append(stage);

      // Floating "Live · synced" badge — ambient confidence signal that
      // the iframe content reflects the persisted project. Only appears
      // for the gateway-served live URL (not the local-files fallback).
      if (resolved.kind === 'live') {
        const badge = el('div', { class: 'preview-live-badge' });
        badge.innerHTML = '<span class="preview-live-dot"></span>Live · synced';
        rightPaneContent.append(badge);
      }
    }

    // Code view — file-tree on the left + viewer on the right (Lovable-style).
    // Tree state (expanded folders, search query, active file) is per-render
    // so re-mounts return to a sensible default instead of stale state.
    async function renderCode(): Promise<void> {
      const codePane = el('div', { class: 'code-pane' });
      const treeWrap = el('div', { class: 'code-tree' });
      const viewer = el('div', { class: 'code-viewer' });
      codePane.append(treeWrap);
      codePane.append(viewer);
      rightPaneContent.append(codePane);

      if (!projectId) {
        viewer.innerHTML = '<div class="empty">No project yet.</div>';
        return;
      }

      let files: Awaited<ReturnType<Window['CentraidApi']['readProjectFiles']>> = [];
      try {
        files = await Api().readProjectFiles({ id: projectId });
      } catch (err) {
        viewer.innerHTML = `<div class="empty">Could not read files: ${escapeHtml(String(err))}</div>`;
        return;
      }

      if (files.length === 0) {
        viewer.innerHTML = '<div class="empty">Empty project.</div>';
        return;
      }

      type TreeNode = {
        name: string;
        path: string; // full path (matches files[].path for files)
        kind: 'file' | 'folder';
        children: TreeNode[];
      };

      // Walk each file's path segments, lazily creating folder nodes. Folder
      // nodes are sorted before files at every level — Lovable does this.
      function buildTree(): TreeNode[] {
        const root: TreeNode[] = [];
        for (const f of files) {
          const parts = f.path.split('/');
          let level = root;
          let acc = '';
          for (let i = 0; i < parts.length; i++) {
            const part = parts[i]!;
            acc = acc ? `${acc}/${part}` : part;
            const isFile = i === parts.length - 1;
            let node = level.find((n) => n.name === part);
            if (!node) {
              node = {
                name: part,
                path: acc,
                kind: isFile ? 'file' : 'folder',
                children: [],
              };
              level.push(node);
            }
            level = node.children;
          }
        }
        const sortLevel = (nodes: TreeNode[]): void => {
          nodes.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          for (const n of nodes) sortLevel(n.children);
        };
        sortLevel(root);
        return root;
      }

      const tree = buildTree();

      // Sensible default selection: index.html if present, else first file.
      let active = files.find((f) => f.path === 'index.html')?.path ?? files[0]!.path;

      // Folders containing the active file start expanded so the user can
      // see where it lives. Search auto-expands matching paths too.
      const expanded = new Set<string>();
      {
        const parts = active.split('/');
        let acc = '';
        for (let i = 0; i < parts.length - 1; i++) {
          acc = acc ? `${acc}/${parts[i]}` : parts[i]!;
          expanded.add(acc);
        }
      }

      let search = '';

      // Pure filter — returns a copy of the tree containing only nodes whose
      // path matches the (lowercased) query, plus their ancestors. Folders
      // along the way are auto-added to expanded so matches are visible.
      function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
        if (!q) return nodes;
        const out: TreeNode[] = [];
        for (const n of nodes) {
          if (n.kind === 'file') {
            if (n.path.toLowerCase().includes(q)) out.push(n);
          } else {
            const kids = filterTree(n.children, q);
            if (kids.length > 0 || n.path.toLowerCase().includes(q)) {
              expanded.add(n.path);
              out.push({ ...n, children: kids });
            }
          }
        }
        return out;
      }

      const drawViewer = (): void => {
        viewer.innerHTML = '';
        const file = files.find((f) => f.path === active);
        if (!file) {
          viewer.innerHTML = '<div class="empty">File not found.</div>';
          return;
        }
        const lang = languageHint(file.path);
        const langLabel = LANG_DISPLAY[lang] ?? 'TEXT';
        const lineCount = file.content.split('\n').length;
        const bytes = new TextEncoder().encode(file.content).byteLength;
        const pathDir = file.path.includes('/')
          ? file.path.slice(0, file.path.lastIndexOf('/'))
          : '';
        const pathName = file.path.includes('/')
          ? file.path.slice(file.path.lastIndexOf('/') + 1)
          : file.path;

        // Filename row: name + colored language pill + Read-only chip.
        const titleRow = el('div', { class: 'code-viewer-title-row' }, [
          ...(pathDir ? [el('span', { class: 'code-viewer-dir' }, pathDir + '/')] : []),
          el('span', { class: 'code-viewer-name' }, pathName),
          el('span', { class: 'code-lang-pill', 'data-lang': lang }, langLabel),
          el('span', { class: 'code-readonly-badge' }, 'Read-only'),
        ]);
        const metaRow = el(
          'span',
          { class: 'code-viewer-meta' },
          `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} · ${formatBytes(bytes)} · synced from gateway`,
        );
        const titleStack = el('div', { class: 'code-viewer-title' }, [titleRow, metaRow]);

        const openBtn = el(
          'button',
          {
            class: 'btn btn-ghost tiny-btn code-open-btn',
            onClick: () => {
              if (projectId) void Api().openProjectFolder({ id: projectId });
            },
          },
          'Open folder',
        );
        const head = el('div', { class: 'code-viewer-head' }, [
          titleStack,
          el('div', { class: 'code-viewer-actions' }, [openBtn]),
        ]);

        const body = el('div', { class: 'code-body' });
        const lines = file.content.split('\n');
        const gutter = el('div', { class: 'code-gutter' });
        lines.forEach((_, i) => gutter.append(el('div', {}, String(i + 1))));
        const text = el('pre', { class: 'code-text' });
        text.innerHTML = tokenize(file.content, lang);
        body.append(gutter);
        body.append(text);
        viewer.append(head);
        viewer.append(body);
      };

      const drawTree = (): void => {
        treeWrap.innerHTML = '';

        const searchInput = el('input', {
          class: 'code-search',
          placeholder: 'Search code',
          value: search,
        }) as HTMLInputElement;
        searchInput.addEventListener('input', () => {
          search = searchInput.value.trim().toLowerCase();
          drawTree();
          // Keep the input focused after re-render.
          const next = treeWrap.querySelector('.code-search') as HTMLInputElement | null;
          if (next) {
            next.focus();
            next.setSelectionRange(search.length, search.length);
          }
        });
        treeWrap.append(searchInput);

        const list = el('div', { class: 'code-tree-list' });
        const visible = filterTree(tree, search);

        const renderRow = (node: TreeNode, depth: number): HTMLElement => {
          if (node.kind === 'folder') {
            const isOpen = expanded.has(node.path);
            const row = el(
              'button',
              {
                class: 'code-tree-row code-tree-folder',
                'data-depth': String(depth),
                onClick: () => {
                  if (expanded.has(node.path)) expanded.delete(node.path);
                  else expanded.add(node.path);
                  drawTree();
                },
              },
              [
                el('span', {
                  class: 'code-tree-chevron',
                  'data-open': String(isOpen),
                  trustedHtml: ChevronIcon(11),
                }),
                el('span', { class: 'code-tree-icon', trustedHtml: FolderIcon(13) }),
                el('span', { class: 'code-tree-name' }, node.name),
              ],
            );
            row.style.setProperty('--depth', String(depth));
            return row;
          }
          const lang = languageHint(node.path);
          const row = el(
            'button',
            {
              class: 'code-tree-row code-tree-file',
              'data-active': String(active === node.path),
              'data-depth': String(depth),
              onClick: () => {
                active = node.path;
                drawTree();
                drawViewer();
              },
            },
            [
              el('span', { class: 'code-tree-chevron-spacer' }),
              el('span', { class: 'code-tree-lang-dot', 'data-lang': lang }),
              el('span', { class: 'code-tree-name' }, node.name),
            ],
          );
          row.style.setProperty('--depth', String(depth));
          return row;
        };

        const walk = (nodes: TreeNode[], depth: number): void => {
          for (const n of nodes) {
            list.append(renderRow(n, depth));
            if (n.kind === 'folder' && expanded.has(n.path)) {
              walk(n.children, depth + 1);
            }
          }
        };

        // Split root-level entries into Frontend (everything the app
        // template ships to the iframe) and Backend (reserved folders
        // that the gateway runs server-side: actions, queries, etc.).
        // Sub-items inside each group keep the existing recursive walk.
        const BACKEND_DIRS = new Set(['actions', 'queries', 'migrations']);
        const backend = visible.filter((n) => n.kind === 'folder' && BACKEND_DIRS.has(n.name));
        const frontend = visible.filter((n) => !backend.includes(n));

        // When search is active we let the user see whatever matched —
        // section headers only appear when both groups are populated.
        const showHeaders = !search && frontend.length > 0 && backend.length > 0;

        if (showHeaders) {
          list.append(el('div', { class: 'code-tree-group-head' }, 'Frontend'));
        }
        walk(frontend, 0);

        if (backend.length > 0) {
          if (showHeaders) {
            list.append(el('div', { class: 'code-tree-group-head' }, 'Backend'));
          }
          walk(backend, 0);
        }

        if (visible.length === 0) {
          list.append(el('div', { class: 'empty code-tree-empty' }, 'No matches'));
        }

        treeWrap.append(list);
      };

      drawTree();
      drawViewer();
    }

    // Cloud view — Lovable-style data-browser. The Overview and Database
    // sections are wired to real gateway data (publish state + live
    // `data.sqlite` schema via CentraidApi.appSchema). The remaining
    // sections (Users, Storage, Secrets, Edge functions, SQL editor, Logs)
    // show "Not yet available" placeholders until their backends ship.
    function renderCloud(): void {
      type CloudSection =
        | 'overview'
        | 'database'
        | 'users'
        | 'storage'
        | 'secrets'
        | 'functions'
        | 'sql'
        | 'logs';
      const sections: [CloudSection, string, (n?: number) => string, boolean][] = [
        ['overview', 'Overview', CloudOverviewIcon, true],
        ['database', 'Database', DatabaseIcon, true],
        ['sql', 'SQL editor', SqlIcon, true],
        ['logs', 'Logs', LogsIcon, true],
        ['users', 'Users', UsersIcon, false],
        ['storage', 'Storage', StorageIcon, false],
        ['secrets', 'Secrets', SecretsIcon, false],
        ['functions', 'Edge functions', FunctionsIcon, false],
      ];

      const cloudPane = el('div', { class: 'cloud-pane' });
      const rail = el('div', { class: 'cloud-rail' });
      const stage = el('div', { class: 'cloud-stage' });
      cloudPane.append(rail);
      cloudPane.append(stage);
      rightPaneContent.append(cloudPane);

      let active: CloudSection = 'overview';
      // Cache the schema across rail clicks so flipping Overview ↔ Database
      // doesn't re-hit the gateway. Reset by the explicit refresh button.
      let schemaCache: CentraidAppSchema | undefined | 'pending' | 'error';
      let schemaError: string | undefined;
      // Cache versions for the Overview tile (active version + count).
      let versionsCache:
        | { activeVersion?: string; versions: CentraidVersionRecord[] }
        | undefined
        | 'pending'
        | 'error';
      let openTable: string | undefined;

      // Row-browser state — keyed by table name so flipping between two open
      // tables remembers their pages.
      type RowsState =
        | { kind: 'idle' }
        | { kind: 'pending' }
        | { kind: 'error'; error: string }
        | { kind: 'ready'; rows: CentraidAppTableRows };
      const rowsCache = new Map<string, RowsState>();
      const tablePage = new Map<string, number>();
      const ROWS_PAGE_SIZE = 50;

      // SQL editor state — survives rail navigation so a draft query isn't
      // lost when the user pops over to Database and back.
      let sqlDraft = '';
      let sqlResult: CentraidRunQueryResult | undefined;
      let sqlError: string | undefined;
      let sqlRunning = false;

      // Logs state — newest-first, polled every 3s while the tab is visible.
      let logsCache: CentraidLogEntry[] | undefined | 'pending' | 'error';
      let logsError: string | undefined;
      let logsLevelFilter: CentraidLogLevel | 'all' = 'all';
      let logsSearch = '';
      // Uses the hoisted `cloudLogsPoll` + `stopCloudLogsPoll` so renderRight
      // (which tears down the right pane on tab switch) can clear it.
      const stopLogsPolling = stopCloudLogsPoll;

      const drawRail = (): void => {
        rail.innerHTML = '';
        const makeBtn = (
          key: CloudSection,
          label: string,
          renderIcon: (n?: number) => string,
          ready: boolean,
        ): HTMLElement => {
          const btn = el('button', {
            class: 'cloud-rail-item',
            'data-active': String(active === key),
            'data-ready': String(ready),
            onClick: () => {
              if (!ready) return;
              if (active === key) return;
              active = key;
              openTable = undefined;
              if (key !== 'logs') stopLogsPolling();
              drawRail();
              drawStage();
            },
          });
          btn.innerHTML = `${renderIcon(14)}<span class="cloud-rail-label">${escapeHtml(label)}</span>`;
          return btn;
        };
        // Ready items first, "Coming soon" group at the bottom under a caps
        // label — so the four active rows own the top of the rail and don't
        // get rhythm-broken by Soon pills sitting at the same weight.
        for (const [key, label, renderIcon, ready] of sections) {
          if (ready) rail.append(makeBtn(key, label, renderIcon, ready));
        }
        const soon = sections.filter((s) => !s[3]);
        if (soon.length > 0) {
          rail.append(el('div', { class: 'cloud-rail-group-head' }, 'Coming soon'));
          for (const [key, label, renderIcon, ready] of soon) {
            rail.append(makeBtn(key, label, renderIcon, ready));
          }
        }
      };

      async function ensureSchema(force = false): Promise<void> {
        if (!projectId) {
          schemaCache = undefined;
          return;
        }
        if (!force && schemaCache !== undefined && schemaCache !== 'error') return;
        schemaCache = 'pending';
        schemaError = undefined;
        try {
          schemaCache = await Api().appSchema({ id: projectId });
        } catch (err) {
          schemaCache = 'error';
          schemaError = err instanceof Error ? err.message : String(err);
        }
        if (active === 'database' || active === 'overview') drawStage();
      }

      async function ensureVersions(force = false): Promise<void> {
        if (!projectId) {
          versionsCache = undefined;
          return;
        }
        if (!force && versionsCache !== undefined && versionsCache !== 'error') return;
        versionsCache = 'pending';
        try {
          versionsCache = await Api().listVersions({ id: projectId });
        } catch {
          // The gateway returns 404/409 before the first publish; treat all
          // failures as "no versions yet" rather than surfacing the raw error.
          versionsCache = { versions: [] };
        }
        if (active === 'overview') drawStage();
      }

      const drawStage = (): void => {
        stage.innerHTML = '';
        // Overview opts in to the atmospheric backdrop; every other section
        // gets the plain canvas. Drop the class on every redraw so the
        // gradient doesn't leak across tabs.
        stage.classList.remove('cloud-stage-atmospheric');
        const def = sections.find(([k]) => k === active);
        const title = def?.[1] ?? '';
        const subtitle =
          active === 'database'
            ? 'Tables, columns, and indexes from your live app database.'
            : active === 'overview'
              ? 'Status of your app on the gateway.'
              : active === 'sql'
                ? 'Run SQL against your live app database. One statement at a time.'
                : active === 'logs'
                  ? 'Recent log lines from query and action handlers.'
                  : 'View and manage the data stored in your app.';

        const head = el('div', { class: 'cloud-stage-head' });
        const headLeft = el('div', {});
        headLeft.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p>`;
        head.append(headLeft);

        if (active === 'database') {
          const refreshBtn = el('button', {
            'aria-label': 'Refresh schema',
            class: 'btn btn-ghost cloud-refresh-btn',
            title: 'Refresh schema',
            onClick: () => void ensureSchema(true),
          });
          refreshBtn.innerHTML = `${RefreshIcon(13)}<span>Refresh</span>`;
          head.append(refreshBtn);
        } else if (active === 'logs') {
          const refreshBtn = el('button', {
            'aria-label': 'Refresh logs',
            class: 'btn btn-ghost cloud-refresh-btn',
            title: 'Refresh logs',
            onClick: () => void refreshLogs(),
          });
          refreshBtn.innerHTML = `${RefreshIcon(13)}<span>Refresh</span>`;
          head.append(refreshBtn);
        }
        stage.append(head);

        if (active === 'overview') {
          drawOverview();
        } else if (active === 'database') {
          drawDatabase();
        } else if (active === 'sql') {
          drawSqlEditor();
        } else if (active === 'logs') {
          drawLogs();
        } else {
          const empty = el('div', { class: 'cloud-empty' });
          empty.textContent =
            'Not yet available. The backend for this section will land in a future release.';
          stage.append(empty);
        }
      };

      function drawOverview(): void {
        if (!projectId) {
          const empty = el('div', { class: 'cloud-empty' });
          empty.textContent = 'No project yet.';
          stage.append(empty);
          return;
        }

        // Kick off both fetches once, in parallel — they are cached and
        // re-rendered when each resolves.
        void ensureSchema();
        void ensureVersions();

        // Atmospheric backdrop — a faint accent-tinted radial behind the
        // cards. Matches the journal-in-shell treatment.
        stage.classList.add('cloud-stage-atmospheric');

        const grid = el('div', { class: 'cloud-stat-grid' });

        // ---- Row 1: LIVE URL (span 2) · Versions · Tables ----
        const liveCard = el('div', { class: 'cloud-stat-card cloud-stat-card--live' });
        if (liveUrl) {
          // Capture into a const so TS keeps the narrowed `string` type
          // inside the click handler closure (the outer `liveUrl` is
          // mutable from the project's perspective).
          const url = liveUrl;
          const eyebrow = el('div', { class: 'cloud-stat-eyebrow' }, [
            el('span', { class: 'cloud-status-dot', 'data-status': 'live' }),
            el('span', {}, 'Live URL'),
          ]);
          const value = el(
            'div',
            { class: 'cloud-stat-value cloud-stat-mono cloud-stat-url' },
            formatPreviewUrl(url),
          );
          const copyBtn = el(
            'button',
            {
              class: 'cloud-stat-copy',
              type: 'button',
              onClick: () => {
                void navigator.clipboard
                  .writeText(url)
                  .then(() => showToast('Copied URL'))
                  .catch(() => showToast('Copy failed'));
              },
            },
            'Copy',
          );
          liveCard.append(eyebrow);
          liveCard.append(value);
          liveCard.append(copyBtn);
        } else {
          liveCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span class="cloud-status-dot" data-status="off"></span><span>Live URL</span></div><div class="cloud-stat-value cloud-stat-muted">Not published</div>';
        }
        grid.append(liveCard);

        const versionCard = el('div', { class: 'cloud-stat-card' });
        if (versionsCache === 'pending' || versionsCache === undefined) {
          versionCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Versions</span></div><div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (versionsCache === 'error') {
          versionCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Versions</span></div><div class="cloud-stat-value cloud-stat-muted">—</div>';
        } else {
          const v = versionsCache;
          versionCard.innerHTML = `<div class="cloud-stat-eyebrow"><span>Versions</span></div><div class="cloud-stat-value">${v.versions.length}</div><div class="cloud-stat-sub">${v.activeVersion ? `Active: ${escapeHtml(v.activeVersion.slice(0, 18))}…` : 'No active version'}</div>`;
        }
        grid.append(versionCard);

        const tableCard = el('div', { class: 'cloud-stat-card' });
        if (schemaCache === 'pending' || schemaCache === undefined) {
          tableCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Tables</span></div><div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (!schemaCache || schemaCache === 'error') {
          tableCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Tables</span></div><div class="cloud-stat-value cloud-stat-muted">—</div>';
        } else {
          const s = schemaCache;
          tableCard.innerHTML = `<div class="cloud-stat-eyebrow"><span>Tables</span></div><div class="cloud-stat-value">${s.tables.length}</div><div class="cloud-stat-sub">${s.indexes.length} indexes · ${s.views.length} views</div>`;
        }
        grid.append(tableCard);

        // ---- Row 2: Schema · Last activity · Gateway (span 2) ----
        const schemaCard = el('div', { class: 'cloud-stat-card' });
        if (schemaCache === 'pending' || schemaCache === undefined) {
          schemaCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Schema version</span></div><div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (schemaCache === 'error') {
          schemaCard.innerHTML = `<div class="cloud-stat-eyebrow"><span>Schema version</span></div><div class="cloud-stat-value cloud-stat-muted">Unavailable</div><div class="cloud-stat-sub">${escapeHtml(schemaError ?? 'gateway error')}</div>`;
        } else if (!schemaCache) {
          schemaCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Schema version</span></div><div class="cloud-stat-value cloud-stat-muted">—</div><div class="cloud-stat-sub">Publish to create the database</div>';
        } else {
          schemaCard.innerHTML = `<div class="cloud-stat-eyebrow"><span>Schema version</span></div><div class="cloud-stat-value">v${schemaCache.schemaVersion}</div><div class="cloud-stat-sub">${schemaCache.schemaVersion === 1 ? 'Never migrated' : 'Up to date'}</div>`;
        }
        grid.append(schemaCard);

        // Last activity — newest version's uploadedAt. Cheap; reuses the
        // same cache we already populated for the Versions card.
        const activityCard = el('div', { class: 'cloud-stat-card' });
        if (versionsCache === 'pending' || versionsCache === undefined) {
          activityCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Last activity</span></div><div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (versionsCache === 'error' || versionsCache.versions.length === 0) {
          activityCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Last activity</span></div><div class="cloud-stat-value cloud-stat-muted">—</div><div class="cloud-stat-sub">No publishes yet</div>';
        } else {
          const newest = [...versionsCache.versions].sort((a, b) =>
            b.uploadedAt.localeCompare(a.uploadedAt),
          )[0]!;
          activityCard.innerHTML = `<div class="cloud-stat-eyebrow"><span>Last activity</span></div><div class="cloud-stat-value cloud-stat-mid">${escapeHtml(relativeWhen(newest.uploadedAt))}</div><div class="cloud-stat-sub">Published from the builder</div>`;
        }
        grid.append(activityCard);

        // Gateway reachability — derived from whether either cache resolved
        // successfully. Avoids a separate ping while still giving the user
        // a green/red signal in the corner.
        const anyOk =
          (versionsCache !== 'pending' &&
            versionsCache !== 'error' &&
            versionsCache !== undefined) ||
          (schemaCache !== 'pending' &&
            schemaCache !== 'error' &&
            schemaCache !== undefined &&
            !!schemaCache);
        const stillLoading =
          versionsCache === 'pending' ||
          versionsCache === undefined ||
          schemaCache === 'pending' ||
          schemaCache === undefined;
        const gatewayCard = el('div', { class: 'cloud-stat-card cloud-stat-card--gateway' });
        if (stillLoading && !anyOk) {
          gatewayCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Gateway</span></div><div class="cloud-stat-value cloud-stat-muted">Checking…</div>';
        } else if (anyOk) {
          gatewayCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Gateway</span></div><div class="cloud-stat-value cloud-stat-mid cloud-stat-inline"><span class="cloud-status-dot" data-status="live"></span>Reachable</div><div class="cloud-stat-sub">openclaw · 18789</div>';
        } else {
          gatewayCard.innerHTML =
            '<div class="cloud-stat-eyebrow"><span>Gateway</span></div><div class="cloud-stat-value cloud-stat-mid cloud-stat-inline"><span class="cloud-status-dot" data-status="off"></span>Unreachable</div><div class="cloud-stat-sub">Check Settings → Gateway</div>';
        }
        grid.append(gatewayCard);

        stage.append(grid);
      }

      function drawDatabase(): void {
        if (!projectId) {
          const empty = el('div', { class: 'cloud-empty' });
          empty.textContent = 'No project yet.';
          stage.append(empty);
          return;
        }

        void ensureSchema();

        if (schemaCache === 'pending' || schemaCache === undefined) {
          const loading = el('div', { class: 'cloud-empty cloud-empty-quiet' });
          loading.textContent = 'Loading schema…';
          stage.append(loading);
          return;
        }

        if (schemaCache === 'error') {
          const err = el('div', { class: 'cloud-empty' });
          err.innerHTML = `Could not load schema.<br><span class="cloud-stat-sub">${escapeHtml(schemaError ?? 'unknown error')}</span>`;
          stage.append(err);
          return;
        }

        if (!schemaCache) {
          const empty = el('div', { class: 'cloud-empty' });
          empty.innerHTML =
            'No database yet.<br><span class="cloud-stat-sub">Publish your app to create <code>data.sqlite</code> on the gateway.</span>';
          stage.append(empty);
          return;
        }

        const s = schemaCache;
        if (s.tables.length === 0) {
          const empty = el('div', { class: 'cloud-empty' });
          empty.innerHTML = `Database is empty.<br><span class="cloud-stat-sub">Schema version v${s.schemaVersion}. Add a migration to create tables.</span>`;
          stage.append(empty);
          return;
        }

        const grid = el('div', { class: 'cloud-table-grid' });
        for (const t of s.tables) {
          const card = el('button', {
            class: 'cloud-table-card',
            'data-active': String(openTable === t.name),
            onClick: () => {
              openTable = openTable === t.name ? undefined : t.name;
              drawDatabase();
            },
          });
          card.innerHTML = `${DatabaseIcon(16)}<div class="cloud-table-card-text"><div class="cloud-table-card-name">${escapeHtml(t.name)}</div><div class="cloud-table-card-sub">${t.columns.length} ${t.columns.length === 1 ? 'column' : 'columns'}</div></div>`;
          grid.append(card);
        }
        stage.append(grid);

        if (openTable) {
          const t = s.tables.find((x) => x.name === openTable);
          if (t) stage.append(renderTableDetail(t, s));
        }
      }

      function renderTableDetail(t: CentraidAppSchemaTable, s: CentraidAppSchema): HTMLElement {
        const wrap = el('div', { class: 'cloud-table-detail' });
        const header = el('div', { class: 'cloud-table-detail-head' });
        header.innerHTML = `<h3>${escapeHtml(t.name)}</h3><span class="cloud-stat-sub">${t.columns.length} columns</span>`;
        wrap.append(header);

        const table = el('div', { class: 'cloud-cols' });
        const rowHead = el('div', { class: 'cloud-cols-row cloud-cols-head' });
        rowHead.innerHTML = '<span>Name</span><span>Type</span><span>Constraints</span>';
        table.append(rowHead);
        for (const c of t.columns) {
          const flags: string[] = [];
          if (c.pk) flags.push('PK');
          if (c.notnull) flags.push('NOT NULL');
          if (c.dflt_value !== null) flags.push(`default ${c.dflt_value}`);
          const row = el('div', { class: 'cloud-cols-row' });
          row.innerHTML = `<span class="cloud-cols-name">${escapeHtml(c.name)}</span><span class="cloud-cols-type">${escapeHtml(c.type || '—')}</span><span class="cloud-cols-flags">${flags.map((f) => `<em>${escapeHtml(f)}</em>`).join(' ') || '—'}</span>`;
          table.append(row);
        }
        wrap.append(table);

        // Row browser. Lives below the columns table so the user can see
        // the schema and the data side by side. Kicks off the first fetch
        // lazily — schema + row data are independent gateway calls.
        wrap.append(renderRowBrowser(t.name));

        const tableIndexes = s.indexes.filter((i) => i.tbl_name === t.name);
        if (tableIndexes.length > 0) {
          const idxHead = el('div', { class: 'cloud-table-detail-head' });
          idxHead.innerHTML = `<h3>Indexes</h3><span class="cloud-stat-sub">${tableIndexes.length}</span>`;
          wrap.append(idxHead);
          const idxList = el('div', { class: 'cloud-sql-list' });
          for (const i of tableIndexes) {
            const row = el('div', { class: 'cloud-sql-row' });
            row.innerHTML = `<div class="cloud-cols-name">${escapeHtml(i.name)}</div><pre>${escapeHtml(i.sql)}</pre>`;
            idxList.append(row);
          }
          wrap.append(idxList);
        }

        if (t.sql) {
          const sqlHead = el('div', { class: 'cloud-table-detail-head' });
          sqlHead.innerHTML = '<h3>CREATE TABLE</h3>';
          wrap.append(sqlHead);
          const pre = el('pre', { class: 'cloud-sql-block' });
          pre.textContent = t.sql;
          wrap.append(pre);
        }

        return wrap;
      }

      // Row browser fragment — header + (loading | error | empty | grid).
      // Fetch + re-render are scoped to one table; switching tables makes a
      // new fragment with its own cached state.
      function renderRowBrowser(tableName: string): HTMLElement {
        const wrap = el('div', { class: 'cloud-rows-wrap' });

        const head = el('div', { class: 'cloud-table-detail-head' });
        head.innerHTML = `<h3>Data</h3>`;
        wrap.append(head);

        const body = el('div', { class: 'cloud-rows-body' });
        wrap.append(body);

        const pager = el('div', { class: 'cloud-rows-pager' });
        wrap.append(pager);

        const page = tablePage.get(tableName) ?? 0;

        const fetchRows = async (): Promise<void> => {
          if (!projectId) return;
          rowsCache.set(tableName, { kind: 'pending' });
          paint();
          try {
            const r = await Api().appTableRows({
              id: projectId,
              table: tableName,
              limit: ROWS_PAGE_SIZE,
              offset: page * ROWS_PAGE_SIZE,
            });
            rowsCache.set(tableName, { kind: 'ready', rows: r });
          } catch (err) {
            rowsCache.set(tableName, {
              kind: 'error',
              error: err instanceof Error ? err.message : String(err),
            });
          }
          paint();
        };

        const paint = (): void => {
          body.innerHTML = '';
          pager.innerHTML = '';

          const state = rowsCache.get(tableName) ?? { kind: 'idle' };
          if (state.kind === 'idle' || state.kind === 'pending') {
            body.append(el('div', { class: 'cloud-empty cloud-empty-quiet' }, 'Loading rows…'));
            return;
          }
          if (state.kind === 'error') {
            const e = el('div', { class: 'cloud-empty' });
            e.innerHTML = `Could not load rows.<br><span class="cloud-stat-sub">${escapeHtml(state.error)}</span>`;
            body.append(e);
            return;
          }

          const r = state.rows;
          if (r.totalCount === 0) {
            body.append(el('div', { class: 'cloud-empty cloud-empty-quiet' }, 'No rows yet.'));
            return;
          }

          const grid = el('div', { class: 'cloud-rows-grid' });
          grid.style.gridTemplateColumns = `repeat(${r.columns.length}, minmax(120px, 1fr))`;

          for (const c of r.columns) {
            const cell = el('div', { class: 'cloud-rows-cell cloud-rows-head-cell' });
            cell.textContent = c;
            grid.append(cell);
          }
          for (const row of r.rows) {
            for (const c of r.columns) {
              const cell = el('div', { class: 'cloud-rows-cell' });
              const v = row[c];
              cell.append(renderCellValue(v));
              grid.append(cell);
            }
          }
          body.append(grid);

          // Pager: show range + prev/next when total > page size.
          const start = r.offset + 1;
          const end = Math.min(r.offset + r.rows.length, r.totalCount);
          const label = el('div', { class: 'cloud-rows-pager-label' });
          label.textContent = `${start}–${end} of ${r.totalCount}`;
          pager.append(label);

          const prev = el(
            'button',
            {
              class: 'btn btn-ghost cloud-rows-pager-btn',
              disabled: page === 0 ? 'true' : null,
              onClick: () => {
                if (page === 0) return;
                tablePage.set(tableName, page - 1);
                void fetchRows();
              },
            },
            'Prev',
          );
          const next = el(
            'button',
            {
              class: 'btn btn-ghost cloud-rows-pager-btn',
              disabled: end >= r.totalCount ? 'true' : null,
              onClick: () => {
                if (end >= r.totalCount) return;
                tablePage.set(tableName, page + 1);
                void fetchRows();
              },
            },
            'Next',
          );
          pager.append(prev);
          pager.append(next);
        };

        paint();
        if ((rowsCache.get(tableName) ?? { kind: 'idle' }).kind === 'idle') {
          void fetchRows();
        }

        return wrap;
      }

      // Render a single cell value. SQLite native types pass through as
      // JS primitives; Buffers come through as `{ type: 'Buffer', data: [] }`.
      // The renderer collapses each to a compact, monospace string.
      function renderCellValue(v: unknown): HTMLElement {
        if (v === null || v === undefined) {
          return el('span', { class: 'cloud-cell-null' }, 'NULL');
        }
        if (typeof v === 'string') {
          const span = el('span', { class: 'cloud-cell-text' });
          span.textContent = v;
          return span;
        }
        if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') {
          const span = el('span', { class: 'cloud-cell-num' });
          span.textContent = String(v);
          return span;
        }
        // Object/array — including Buffer-shaped values. Stringify so the
        // grid stays readable even for BLOB columns.
        const span = el('span', { class: 'cloud-cell-json' });
        try {
          span.textContent = JSON.stringify(v);
        } catch {
          span.textContent = '[unserializable]';
        }
        return span;
      }

      // SQL editor section. Textarea + Run (Cmd/Ctrl-Enter) + result panel.
      // Single statement; destructive statements (DROP/ALTER/DELETE/UPDATE
      // /TRUNCATE/INSERT without WHERE — anything non-read) get a confirm
      // dialog. Read-style statements run straight through.
      function drawSqlEditor(): void {
        if (!projectId) {
          stage.append(el('div', { class: 'cloud-empty' }, 'No project yet.'));
          return;
        }

        const wrap = el('div', { class: 'cloud-sql-editor' });

        const textarea = el('textarea', {
          class: 'cloud-sql-textarea',
          spellcheck: 'false',
          placeholder: 'SELECT * FROM …',
        }) as HTMLTextAreaElement;
        textarea.value = sqlDraft;
        textarea.addEventListener('input', () => {
          sqlDraft = textarea.value;
        });
        textarea.addEventListener('keydown', (e: KeyboardEvent) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            void run();
          }
        });
        wrap.append(textarea);

        const controls = el('div', { class: 'cloud-sql-controls' });
        const runBtn = el(
          'button',
          {
            class: 'btn btn-primary cloud-sql-run-btn',
            onClick: () => void run(),
          },
          sqlRunning ? 'Running…' : 'Run',
        );
        if (sqlRunning) (runBtn as HTMLButtonElement).disabled = true;
        controls.append(runBtn);
        const hint = el('span', { class: 'cloud-sql-hint' }, '⌘/Ctrl + Enter to run');
        controls.append(hint);
        wrap.append(controls);

        const out = el('div', { class: 'cloud-sql-output' });
        wrap.append(out);

        const paintOutput = (): void => {
          out.innerHTML = '';
          if (sqlError) {
            const e = el('div', { class: 'cloud-sql-error' });
            e.textContent = sqlError;
            out.append(e);
            return;
          }
          if (!sqlResult) return;

          if (sqlResult.kind === 'exec') {
            const m = el('div', { class: 'cloud-sql-meta' });
            const idPart =
              sqlResult.lastInsertRowid !== null
                ? ` · lastInsertRowid ${sqlResult.lastInsertRowid}`
                : '';
            m.textContent = `${sqlResult.rowsAffected} ${sqlResult.rowsAffected === 1 ? 'row' : 'rows'} affected · ${sqlResult.durationMs}ms${idPart}`;
            out.append(m);
            return;
          }

          const m = el('div', { class: 'cloud-sql-meta' });
          m.textContent = `${sqlResult.rows.length} ${sqlResult.rows.length === 1 ? 'row' : 'rows'} · ${sqlResult.durationMs}ms`;
          out.append(m);
          if (sqlResult.rows.length === 0) {
            out.append(el('div', { class: 'cloud-empty cloud-empty-quiet' }, 'No rows returned.'));
            return;
          }
          const grid = el('div', { class: 'cloud-rows-grid' });
          grid.style.gridTemplateColumns = `repeat(${sqlResult.columns.length}, minmax(120px, 1fr))`;
          for (const c of sqlResult.columns) {
            const cell = el('div', { class: 'cloud-rows-cell cloud-rows-head-cell' });
            cell.textContent = c;
            grid.append(cell);
          }
          for (const row of sqlResult.rows) {
            for (const c of sqlResult.columns) {
              const cell = el('div', { class: 'cloud-rows-cell' });
              cell.append(renderCellValue(row[c]));
              grid.append(cell);
            }
          }
          out.append(grid);
        };

        paintOutput();
        stage.append(wrap);

        async function run(): Promise<void> {
          if (sqlRunning) return;
          const sql = sqlDraft.trim();
          if (!sql) return;

          // Destructive-statement confirm. Naive prefix check — false
          // positives are acceptable (the user can still confirm) and
          // false negatives are guarded by the gateway itself.
          if (isDestructive(sql)) {
            const ok = window.confirm(
              'This SQL is not a read query (SELECT/PRAGMA/EXPLAIN). It may modify or delete data. Continue?',
            );
            if (!ok) return;
          }

          sqlRunning = true;
          sqlError = undefined;
          sqlResult = undefined;
          drawStage(); // re-paint with disabled button + cleared output

          try {
            const r = await Api().appQuery({ id: projectId!, sql });
            sqlResult = r;
          } catch (err) {
            sqlError = err instanceof Error ? err.message : String(err);
          } finally {
            sqlRunning = false;
            drawStage();
          }
        }
      }

      function isDestructive(sql: string): boolean {
        const first = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, '').match(/^(\w+)/);
        const kw = first?.[1]?.toUpperCase();
        if (!kw) return false;
        return !['SELECT', 'PRAGMA', 'EXPLAIN', 'WITH', 'VALUES'].includes(kw);
      }

      // Logs section. Newest-first list with level chips, search, and a 3s
      // poll while the section is active. Polling pauses when the user
      // navigates away (rail click in drawRail clears the handle).
      function drawLogs(): void {
        if (!projectId) {
          stage.append(el('div', { class: 'cloud-empty' }, 'No project yet.'));
          return;
        }

        const wrap = el('div', { class: 'cloud-logs' });

        // Filter row — level chips + search box.
        const filter = el('div', { class: 'cloud-logs-filter' });
        const levels: Array<CentraidLogLevel | 'all'> = ['all', 'info', 'warn', 'error'];
        for (const lvl of levels) {
          const chip = el(
            'button',
            {
              class: 'cloud-logs-chip',
              'data-active': String(logsLevelFilter === lvl),
              'data-level': lvl,
              onClick: () => {
                if (logsLevelFilter === lvl) return;
                logsLevelFilter = lvl;
                drawStage();
              },
            },
            lvl === 'all' ? 'All' : lvl.charAt(0).toUpperCase() + lvl.slice(1),
          );
          filter.append(chip);
        }
        const search = el('input', {
          class: 'cloud-logs-search',
          placeholder: 'Filter…',
          type: 'search',
        }) as HTMLInputElement;
        search.value = logsSearch;
        search.addEventListener('input', () => {
          logsSearch = search.value;
          renderList();
        });
        filter.append(search);
        wrap.append(filter);

        const list = el('div', { class: 'cloud-logs-list' });
        wrap.append(list);

        const renderList = (): void => {
          list.innerHTML = '';

          if (logsCache === 'pending' || logsCache === undefined) {
            list.append(el('div', { class: 'cloud-empty cloud-empty-quiet' }, 'Loading logs…'));
            return;
          }
          if (logsCache === 'error') {
            const e = el('div', { class: 'cloud-empty' });
            e.innerHTML = `Could not load logs.<br><span class="cloud-stat-sub">${escapeHtml(logsError ?? 'unknown error')}</span>`;
            list.append(e);
            return;
          }

          const needle = logsSearch.trim().toLowerCase();
          const filtered = logsCache.filter((entry) => {
            if (logsLevelFilter !== 'all' && entry.level !== logsLevelFilter) return false;
            if (!needle) return true;
            return (
              entry.msg.toLowerCase().includes(needle) ||
              entry.handler.toLowerCase().includes(needle) ||
              entry.source.toLowerCase().includes(needle)
            );
          });

          if (filtered.length === 0) {
            list.append(
              el(
                'div',
                { class: 'cloud-empty cloud-empty-quiet' },
                logsCache.length === 0
                  ? 'No logs yet. Run a query or action to produce log lines.'
                  : 'No logs match the current filter.',
              ),
            );
            return;
          }

          for (const entry of filtered) {
            const row = el('div', {
              class: 'cloud-logs-row',
              'data-level': entry.level,
            });
            const when = new Date(entry.ts);
            const ts = `${pad2(when.getHours())}:${pad2(when.getMinutes())}:${pad2(when.getSeconds())}`;
            row.append(el('span', { class: 'cloud-logs-ts' }, ts));
            row.append(el('span', { class: 'cloud-logs-level' }, entry.level.toUpperCase()));
            row.append(
              el('span', { class: 'cloud-logs-source' }, `${entry.source}/${entry.handler}`),
            );
            const msg = el('span', { class: 'cloud-logs-msg' });
            msg.textContent = entry.msg;
            row.append(msg);
            list.append(row);
          }
        };

        renderList();
        stage.append(wrap);

        // Kick off first fetch + start polling.
        if (logsCache === undefined) {
          void refreshLogs();
        }
        stopLogsPolling();
        cloudLogsPoll = setInterval(() => {
          if (active !== 'logs') {
            stopLogsPolling();
            return;
          }
          void refreshLogs();
        }, 3000);
      }

      async function refreshLogs(): Promise<void> {
        if (!projectId) return;
        if (logsCache === 'pending') return;
        const prior = logsCache;
        logsCache = 'pending';
        // Only redraw if there was no prior data — polling refreshes shouldn't
        // flash "Loading…" on every tick.
        if (prior === undefined) {
          if (active === 'logs') {
            const list = stage.querySelector('.cloud-logs-list') as HTMLElement | null;
            if (list)
              list.innerHTML = '<div class="cloud-empty cloud-empty-quiet">Loading logs…</div>';
          }
        }
        try {
          const r = await Api().appLogs({ id: projectId, limit: 200 });
          logsCache = r.entries;
          logsError = undefined;
        } catch (err) {
          logsCache = 'error';
          logsError = err instanceof Error ? err.message : String(err);
        }
        if (active === 'logs') drawStage();
      }

      function pad2(n: number): string {
        return n < 10 ? `0${n}` : String(n);
      }

      drawRail();
      drawStage();
    }

    // Renders the version list into the supplied container. Used by the
    // chat-pane History view (chatView === 'history'); kept generic so a
    // future right-pane history view could reuse it.
    async function renderHistoryInto(list: HTMLElement): Promise<void> {
      if (!projectId) {
        list.innerHTML = '<div class="empty">No project yet.</div>';
        return;
      }

      let result: Awaited<ReturnType<Window['CentraidApi']['listVersions']>>;
      try {
        result = await Api().listVersions({ id: projectId });
      } catch (err) {
        list.innerHTML = `<div class="empty">No versions yet. Publish to create the first one.</div>`;
        // Fall back to empty list — gateway returns 404/409 if app isn't yet uploaded.
        console.warn('listVersions failed', err);
        return;
      }

      if (!result.versions.length) {
        list.innerHTML =
          '<div class="empty">No versions yet. Publish to create the first one.</div>';
        return;
      }

      const sorted = [...result.versions].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

      const draw = (): void => {
        list.innerHTML = '';
        for (const v of sorted) {
          const isCurrent = v.versionId === result.activeVersion;
          const item = el('div', { class: 'history-item', 'data-active': String(isCurrent) }, [
            el('div', { class: 'history-thumb' }, [el('div', { class: 'thumb-shimmer' })]),
            el('div', { class: 'history-meta' }, [
              el(
                'div',
                { class: 'history-title' },
                [
                  el('b', {}, shortVersionTitle(v)),
                  isCurrent ? el('span', { class: 'current-tag' }, '● current') : null,
                ].filter((x): x is HTMLElement => x !== null),
              ),
              el('div', { class: 'history-when' }, relativeWhen(v.uploadedAt)),
              el(
                'p',
                { class: 'history-prompt' },
                `${v.files} files · ${(v.bytes / 1024).toFixed(1)} KB · sha ${v.sha256.slice(0, 8)}`,
              ),
            ]),
            el(
              'div',
              { class: 'history-actions' },
              [
                !isCurrent
                  ? el(
                      'button',
                      {
                        class: 'btn btn-soft tiny-btn',
                        onClick: async () => {
                          try {
                            await Api().activateVersion({
                              id: projectId!,
                              versionId: v.versionId,
                            });
                            showToast(`Restored to ${shortVersionTitle(v)}`);
                            lastPublishedVersionId = v.versionId;
                            if (chatView === 'history') renderChatPane();
                            if (tab === 'preview') renderRight();
                          } catch (err) {
                            showToast(`Restore failed: ${String(err)}`);
                          }
                        },
                      },
                      'Restore',
                    )
                  : null,
              ].filter((x): x is HTMLElement => x !== null),
            ),
          ]);
          list.append(item);
        }
      };
      draw();
    }

    // ---------- Agent wiring ----------
    async function startAgentSession(
      id: string,
      sessionMode: 'fresh' | 'continue' | 'in-memory',
    ): Promise<{ messages: import('./centraid-api.js').CentraidAgentMessage[] }> {
      // Subscribe BEFORE start so we don't miss the very first text deltas.
      if (unsubscribeAgent) {
        unsubscribeAgent();
        unsubscribeAgent = null;
      }
      unsubscribeAgent = Api().onAgentEvent((msg) => {
        if (msg.projectId !== id) return;
        handleAgentEvent(msg.event);
      });
      const result = await Api().startAgent({ projectId: id, sessionMode });
      return { messages: result.messages };
    }

    // Convert pi's persisted AgentMessage[] (returned by startAgent for
    // resumed sessions) into the renderer's ChatMsg[] so the chat pane
    // shows the prior conversation when the user reopens a project.
    //
    // Walk each assistant message's content array IN ORDER so thinking,
    // text, and tool calls render in the same sequence the user saw live.
    // Tool-result messages patch the matching tool row's state by id.
    function hydrateChatFromMessages(
      messages: import('./centraid-api.js').CentraidAgentMessage[],
    ): ChatMsg[] {
      const out: ChatMsg[] = [];
      // toolCallId → index of the toolGroup that contains it. Lets a
      // toolResult message later patch the matching call's state.
      const groupIdxByCallId = new Map<string, number>();
      const extractText = (
        content: string | import('./centraid-api.js').CentraidContentBlock[],
      ): string => {
        if (typeof content === 'string') return content;
        let s = '';
        for (const c of content) {
          if (c.type === 'text' && typeof (c as { text?: unknown }).text === 'string') {
            s += (c as { text: string }).text;
          }
        }
        return s;
      };

      for (const m of messages) {
        if (m.role === 'user') {
          const text = extractText(
            (m as { content: string | import('./centraid-api.js').CentraidContentBlock[] }).content,
          );
          if (text) out.push({ kind: 'user', text });
          continue;
        }
        if (m.role === 'assistant') {
          const content = (m as { content: import('./centraid-api.js').CentraidContentBlock[] })
            .content;
          let textBuf = '';
          let thinkBuf = '';
          const flushText = (): void => {
            if (textBuf) {
              out.push({ kind: 'ai', text: textBuf });
              textBuf = '';
            }
          };
          const flushThink = (): void => {
            if (thinkBuf) {
              out.push({ kind: 'thinking', text: thinkBuf });
              thinkBuf = '';
            }
          };
          for (const c of content) {
            if (c.type === 'text' && typeof (c as { text?: unknown }).text === 'string') {
              flushThink();
              textBuf += (c as { text: string }).text;
            } else if (
              c.type === 'thinking' &&
              typeof (c as { thinking?: unknown }).thinking === 'string'
            ) {
              flushText();
              thinkBuf += (c as { thinking: string }).thinking;
            } else if (c.type === 'toolCall') {
              flushText();
              flushThink();
              const tc = c as { id: string; name: string; arguments: Record<string, unknown> };
              const newCall: ToolCall = {
                id: tc.id,
                tool: tc.name,
                summary: summarizeToolArgs(tc.name, tc.arguments),
                state: 'ok',
              };
              const last = out[out.length - 1];
              if (last && last.kind === 'toolGroup') {
                // Same group as the previous adjacent tool call — append.
                last.calls.push(newCall);
                groupIdxByCallId.set(tc.id, out.length - 1);
              } else {
                // Historical groups start collapsed; the user already saw
                // them once and this view is retrospective.
                out.push({
                  kind: 'toolGroup',
                  id: tc.id,
                  calls: [newCall],
                  open: false,
                });
                groupIdxByCallId.set(tc.id, out.length - 1);
              }
            }
          }
          flushText();
          flushThink();
          continue;
        }
        if (m.role === 'toolResult') {
          const tr = m as { toolCallId: string; isError: boolean };
          const idx = groupIdxByCallId.get(tr.toolCallId);
          if (idx !== undefined) {
            const cur = out[idx];
            if (cur && cur.kind === 'toolGroup') {
              cur.calls = cur.calls.map((c) =>
                c.id === tr.toolCallId ? { ...c, state: tr.isError ? 'error' : 'ok' } : c,
              );
            }
          }
          continue;
        }
        // bashExecution / custom / branchSummary / compactionSummary —
        // skip silently. They're noise for the user-facing chat view.
      }
      return out;
    }

    // Stop streaming on the open thinking block (if any). New tool calls or
    // assistant text close the previous thought, mirroring Claude Code / Codex.
    function closeThinking(): void {
      if (currentThinkingMsgIndex < 0) return;
      const cur = chat[currentThinkingMsgIndex];
      if (cur && cur.kind === 'thinking') {
        updateMessage(currentThinkingMsgIndex, { streaming: false });
      }
      currentThinkingMsgIndex = -1;
    }

    function closeAi(): void {
      if (currentAiMsgIndex < 0) return;
      const cur = chat[currentAiMsgIndex];
      if (cur && cur.kind === 'ai') {
        updateMessage(currentAiMsgIndex, { streaming: false });
      }
      currentAiMsgIndex = -1;
    }

    function handleAgentEvent(event: import('./centraid-api.js').CentraidAgentEvent): void {
      switch (event.type) {
        case 'agent_start':
        case 'turn_start':
        case 'message_start':
          generating = true;
          // Don't pre-create an empty AI bubble — codex turns may emit only
          // reasoning + tool calls, leaving a stale "…" placeholder. We
          // create the bubble lazily on the first text_delta instead.
          renderChat();
          break;
        case 'message_update': {
          const ame = event.assistantMessageEvent as {
            type: string;
            delta?: unknown;
          };
          if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
            closeThinking();
            if (currentAiMsgIndex < 0) {
              currentAiMsgIndex = pushMessage({ kind: 'ai', text: ame.delta, streaming: true });
            } else {
              const cur = chat[currentAiMsgIndex];
              if (cur && cur.kind === 'ai') {
                updateMessage(currentAiMsgIndex, { text: cur.text + ame.delta, streaming: true });
              }
            }
          } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string') {
            if (currentThinkingMsgIndex < 0) {
              currentThinkingMsgIndex = pushMessage({
                kind: 'thinking',
                text: ame.delta,
                streaming: true,
              });
            } else {
              const cur = chat[currentThinkingMsgIndex];
              if (cur && cur.kind === 'thinking') {
                updateMessage(currentThinkingMsgIndex, {
                  text: cur.text + ame.delta,
                  streaming: true,
                });
              }
            }
          } else if (ame.type === 'thinking_end' || ame.type === 'text_end') {
            // Stream of this content block ended; close the matching bubble.
            if (ame.type === 'thinking_end') closeThinking();
            else closeAi();
          }
          break;
        }
        case 'message_end': {
          closeAi();
          closeThinking();
          break;
        }
        case 'tool_execution_start': {
          // A tool call is the agent acting; any in-flight reasoning is done.
          closeThinking();
          const newCall: ToolCall = {
            id: event.toolCallId,
            tool: event.toolName,
            summary: summarizeToolArgs(event.toolName, event.args),
            state: 'running',
          };
          const lastIdx = chat.length - 1;
          const last = chat[lastIdx];
          // Consolidate adjacent tool calls into one bubble. AI text or
          // thinking content between calls breaks the group, so a fresh one
          // is created when the previous chat msg isn't a toolGroup.
          if (last && last.kind === 'toolGroup') {
            const updated: ChatMsg = { ...last, calls: [...last.calls, newCall] };
            chat = chat.map((m, i) => (i === lastIdx ? updated : m));
            renderChat();
            pendingToolStarts.set(event.toolCallId, lastIdx);
          } else {
            // New groups start expanded so the user sees what's running as
            // it happens; they can collapse for retrospective compactness.
            const idx = pushMessage({
              kind: 'toolGroup',
              id: event.toolCallId,
              calls: [newCall],
              open: true,
            });
            pendingToolStarts.set(event.toolCallId, idx);
          }
          break;
        }
        case 'tool_execution_end': {
          const groupIdx = pendingToolStarts.get(event.toolCallId);
          pendingToolStarts.delete(event.toolCallId);
          if (groupIdx !== undefined) {
            const grp = chat[groupIdx];
            if (grp && grp.kind === 'toolGroup') {
              const calls = grp.calls.map((c) =>
                c.id === event.toolCallId
                  ? { ...c, state: event.isError ? ('error' as const) : ('ok' as const) }
                  : c,
              );
              chat = chat.map((m, i) => (i === groupIdx ? { ...grp, calls } : m));
              renderChat();
            }
          }
          if (!event.isError && FILE_WRITING_TOOLS.has(event.toolName)) {
            previewReloadPending = true;
            // Successful file write counts as an edit — bump the header
            // relative-time so 'edited 14h ago' rolls to 'just now'.
            appLastEditedAt = Date.now();
          }
          break;
        }
        case 'turn_end':
        case 'agent_end':
          generating = false;
          closeAi();
          closeThinking();
          renderChat();
          // Refresh code/preview tab if visible — agent may have written files.
          if (tab === 'code') renderRight();
          if (tab === 'preview' && previewReloadPending) renderRight();
          previewReloadPending = false;
          break;
        default:
          break;
      }
    }

    async function sendUserPrompt(text: string): Promise<void> {
      if (!projectId) return;
      pushMessage({ kind: 'user', text });
      generating = true;
      currentAiMsgIndex = -1;
      currentThinkingMsgIndex = -1;
      renderChat();
      try {
        await Api().promptAgent({ text });
      } catch (err) {
        generating = false;
        pushMessage({ kind: 'status', text: `Agent error: ${String(err)}` });
      }
    }

    async function bootstrap(): Promise<void> {
      if (isUpdateMode && projectId) {
        // No "Editing existing project" divider — the project context lives
        // in the header now (icon + name + version + sync state). Real chat
        // history loads below; nothing to seed.
        chat = [];
        renderChat();
        // Probe whether this project is actually published on the gateway.
        // `appLiveUrl` only builds a URL string — it never fails — so it
        // can't tell us whether the gateway has the app or is even running.
        // `listVersions` actually contacts the gateway and 404s when the app
        // isn't there, so it's the honest probe.
        try {
          const versions = await Api().listVersions({ id: projectId });
          if (versions.activeVersion) {
            const r = await Api().appLiveUrl({ id: projectId });
            liveUrl = r.url;
            lastPublishedVersionId = versions.activeVersion;
            // Hydrate the header status: total version count drives the
            // `v{N}` label, the active version's embedded timestamp drives
            // the `edited Xh ago` relative time.
            appVersionCount = versions.versions.length;
            appLastEditedAt = parseVersionTime(versions.activeVersion);
            refreshSyncStatus();
          }
        } catch {
          /* gateway down, app unknown, or never published — local preview
             takes over via resolvePreviewSrc(). */
        }
        // Resume the most recent persisted session for this project so the
        // chat history survives builder reloads. Hydrate the chat pane from
        // the messages pi already has on disk before any new turn streams in.
        const { messages } = await startAgentSession(projectId, 'continue');
        const hydrated = hydrateChatFromMessages(messages);
        if (hydrated.length > 0) {
          chat = chat.concat(hydrated);
        } else {
          chat = chat.concat([
            {
              kind: 'ai',
              text: `Loaded "${projName}". Pick a direction below or describe the next change.`,
            },
          ]);
        }
        renderChat();
        // Subtitle slot now holds the editable `app.json#description`, so
        // we don't overwrite it here.
        return;
      }

      if (!isNewBuild || !initialPrompt) {
        chat = [
          {
            kind: 'status',
            text: 'No prompt provided. Open the builder from "New app" on home.',
          },
        ];
        renderChat();
        return;
      }

      // Fresh build: scaffold + start agent + send first prompt.
      const id = generateProjectId(initialPrompt);
      pushMessage({ kind: 'divider', text: 'Today' });
      pushMessage({ kind: 'status', text: 'Setting up project…', spinning: true });
      try {
        await Api().createProject({ id, name: projName, version: '0.1.0' });
        projectId = id;
        // Subtitle holds the editable description, not a status — leave it
        // alone so the user's placeholder/value isn't clobbered.
      } catch (err) {
        pushMessage({ kind: 'status', text: `Could not create project: ${String(err)}` });
        return;
      }

      try {
        // First build → fresh persisted session (so the initial prompt isn't
        // appended onto a stale transcript from a previous project at the
        // same path).
        await startAgentSession(id, 'fresh');
      } catch (err) {
        pushMessage({ kind: 'status', text: `Agent failed to start: ${String(err)}` });
        return;
      }

      pushMessage({ kind: 'user', text: initialPrompt });
      generating = true;
      renderChat();
      try {
        await Api().promptAgent({ text: initialPrompt });
      } catch (err) {
        generating = false;
        pushMessage({ kind: 'status', text: `Agent error: ${String(err)}` });
      }
    }

    // ---------- Publish ----------
    async function handlePublish(): Promise<void> {
      if (!projectId) {
        showToast('No project to publish');
        return;
      }
      if (publishing) return;
      publishing = true;
      refreshSyncStatus();
      const statusIdx = pushMessage({
        kind: 'status',
        text: 'Building & publishing…',
        spinning: true,
      });
      primaryBtn.setAttribute('disabled', '');
      try {
        const result = await Api().publish({ id: projectId });
        lastPublishedVersionId = result.versionId;
        liveUrl = (await Api().appLiveUrl({ id: projectId })).url;
        // Bump the header status: every publish increments the version
        // count and resets the relative edit time to "just now".
        appVersionCount += 1;
        appLastEditedAt = Date.now();
        refreshSyncStatus();
        const migCount = result.migrationsApplied?.length ?? 0;
        const migText =
          migCount > 0 ? ` · ${migCount} migration${migCount === 1 ? '' : 's'} applied` : '';
        updateMessage(statusIdx, {
          kind: 'status',
          text: `Published ${shortVersionTitle(result)} (${result.files} files, ${(result.bytes / 1024).toFixed(1)} KB)${migText}`,
        });
        showToast(`Published ${shortVersionTitle(result)}${migText}`);
        if (chatView === 'history') renderChatPane();
        if (tab === 'preview') renderRight();
        if (onAddToHome) {
          onAddToHome({
            prompt: initialPrompt,
            projectId,
            name: projName,
            versionId: result.versionId,
          });
        }
      } catch (err) {
        const msg = String(err);
        if (/HTTP 401|HTTP 403|gateway rejected|auth_required/i.test(msg)) {
          updateMessage(statusIdx, {
            kind: 'status',
            text: 'Gateway needs a token to accept uploads.',
          });
          showActionToast(
            'Gateway requires a token. Configure it in Settings.',
            'Open Settings',
            () => void window.Centraid?.openSettings?.(),
          );
        } else if (
          /gateway_unreachable|Could not reach gateway|fetch failed|ECONNREFUSED/i.test(msg)
        ) {
          updateMessage(statusIdx, {
            kind: 'status',
            text: 'Gateway not reachable. Is openclaw running?',
          });
          showActionToast(
            'Gateway not reachable. Check the URL in Settings.',
            'Open Settings',
            () => void window.Centraid?.openSettings?.(),
          );
        } else if (/HTTP 422/i.test(msg)) {
          // Migration error from the gateway. Pull the offending file out of
          // the JSON-in-error-message body for a friendlier line.
          const fileMatch = msg.match(/"file"\s*:\s*"([^"]+)"/);
          const errMatch = msg.match(/"sqlError"\s*:\s*"([^"]+)"/);
          const file = fileMatch?.[1];
          const sqlError = errMatch?.[1];
          const detail = file
            ? sqlError
              ? `Migration ${file} failed: ${sqlError}`
              : `Migration ${file} failed`
            : `Migration failed: ${msg}`;
          updateMessage(statusIdx, { kind: 'status', text: detail });
          showToast(file ? `Migration ${file} failed` : 'Migration failed');
        } else {
          updateMessage(statusIdx, { kind: 'status', text: `Publish failed: ${msg}` });
        }
      } finally {
        publishing = false;
        refreshSyncStatus();
        primaryBtn.removeAttribute('disabled');
      }
    }

    function handleExit(): void {
      onExit();
    }

    // ---------- Mount ----------
    // The builder lives inside a cd-window grid (sidebar column + main
    // column). There's no more full-width cd-app-strip — the chat pane
    // owns its own header (project meta + Publish), the right pane
    // owns its own toolbar (tabs + URL bar), and the window chrome
    // (cd-tl-main) carries just back/forward/sidebar — matching the
    // v2 mockup's per-pane layout.
    const main = el('div', { class: 'builder' }, [body]);
    main.style.flexDirection = 'column';
    main.style.display = 'flex';
    main.style.minHeight = '0';

    // Sidebar matches the home shell — workspace switcher, apps list,
    // drafts, Settings. Clicking an app exits the builder and routes to
    // that app via the shell's normal flow.
    const sidebarUserApps = Store.get<UserAppMeta[]>('home.userApps', []);
    const sidebarApps: ChromeSidebarApp[] = sidebarUserApps.map((a) => ({
      color: a.color,
      iconKey: a.iconKey,
      id: a.id,
      name: a.name,
      status: 'new',
    }));
    const sidebar = window.Chrome.buildSidebar({
      activeId: opts.projectId,
      apps: sidebarApps,
      // Drafts come from the shell's hydrated cache (passed via
      // BuilderOptions). Older callers may omit them — default to empty.
      // The currently-open project will appear here too when it's a draft,
      // and `activeId` highlights it just like the home sidebar does.
      drafts: opts.drafts ?? [],
      onAppClick: (id: string) => {
        // Let the shell route the click — `openApp` (a) calls `clear()`,
        // which fires our `currentCleanup` and tears this builder down,
        // and (b) branches to `enterBuilder` for drafts vs `mountUserApp`
        // for published apps. We deliberately do NOT call `handleExit()`
        // here: `onExit` is `renderHome`, which is async, and racing it
        // against `openApp` ends up appending the home shell underneath
        // the freshly-mounted builder. The teardown that `clear()` does
        // is sufficient.
        if (typeof window.Centraid?.openApp === 'function') {
          window.Centraid.openApp(id);
        }
      },
      // Hover-revealed `•••` + right-click on sidebar rows route through
      // the home shell so Rename / Delete / Reveal in Finder behave the
      // same in the builder as on home — no second implementation.
      onAppContext: (id: string, anchor: MenuAnchor) => {
        if (typeof window.Centraid?.openAppContext === 'function') {
          window.Centraid.openAppContext(id, anchor);
        }
      },
      onHome: handleExit,
      onNewApp: () => {
        /* already in builder; ignore */
      },
      onSettings: () => {
        if (typeof window.Centraid?.openSettings === 'function') {
          void window.Centraid.openSettings();
        }
      },
    });

    let builderSidebarOpen = Store.get<boolean>('appearance.sidebarOpen', true);
    let builderChatOpen = Store.get<boolean>('builder.chatPaneOpen', true);
    // Initial chat-pane state on the .builder root — drives the data-chat
    // CSS rules that collapse .builder-body's first column to 0.
    main.dataset.chat = builderChatOpen ? 'open' : 'closed';
    // Assigned after buildWindow() returns; toggleChatPane reads it through
    // its closure at call-time, so the initial undefined binding is fine.
    let setShellChatPaneOpen: (open: boolean) => void = () => {
      /* assigned below */
    };
    const toggleChatPane = (): void => {
      builderChatOpen = !builderChatOpen;
      Store.set('builder.chatPaneOpen', builderChatOpen);
      main.dataset.chat = builderChatOpen ? 'open' : 'closed';
      setShellChatPaneOpen(builderChatOpen);
    };
    const {
      root: shell,
      setSidebarOpen: setShellSidebarOpen,
      setChatPaneOpen: chromeSetChatPaneOpen,
    } = window.Chrome.buildWindow({
      canGoBack: opts.canGoBack,
      canGoForward: opts.canGoForward,
      main,
      onBack: opts.onBack,
      onForward: opts.onForward,
      onNewChat: handleExit,
      onToggleSidebar: () => {
        builderSidebarOpen = !builderSidebarOpen;
        Store.set('appearance.sidebarOpen', builderSidebarOpen);
        setShellSidebarOpen(builderSidebarOpen);
      },
      onToggleChat: toggleChatPane,
      showChatToggle: true,
      chatPaneOpen: builderChatOpen,
      showNewChat: true,
      sidebar,
      sidebarOpen: builderSidebarOpen,
      // Tabs (Preview / Code / Cloud) + device pill (Phone / Tablet /
      // Desktop) ride in the window chrome row as the center cluster —
      // killing the old right-pane-toolbar row. Project identity stays
      // in the chat pane's own header (builder-pane-header), so no
      // titlebarRight on the chrome row.
      titlebarCenter: builderTitlebarCenter,
    });
    setShellChatPaneOpen = chromeSetChatPaneOpen;
    root.append(shell);

    // Template-clone path drops the user here with the template's name as
    // the working title. Auto-focus + select so they can type a new name
    // immediately (Notion: "Duplicate" lands you in rename mode).
    if (opts.focusName) {
      requestAnimationFrame(() => {
        projNameEl.focus();
        const range = document.createRange();
        range.selectNodeContents(projNameEl);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
    }

    // ⌘\ toggles the chat pane (companion to ⌘B for workspace sidebar).
    // VS Code / Cursor use this exact pair. Registered on document so it
    // fires regardless of focus; ignored when a text field is the target
    // so the user can still type a literal backslash.
    const onChatToggleKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== '\\') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      toggleChatPane();
    };
    document.addEventListener('keydown', onChatToggleKey);

    // renderChatPane() mounts chat-scroll + input the first time, then
    // renderChat()/renderInput() repaint via the references it sets up.
    renderChatPane();
    renderRight();
    refreshTopbarToggles();
    refreshSyncStatus();

    // Kick off async setup.
    void bootstrap();

    // Cleanup
    return () => {
      document.removeEventListener('keydown', onChatToggleKey);
      if (unsubscribeAgent) {
        unsubscribeAgent();
        unsubscribeAgent = null;
      }
      void Api()
        .stopAgent()
        .catch(() => undefined);
    };
  }

  window.openBuilder = openBuilder;
})();
