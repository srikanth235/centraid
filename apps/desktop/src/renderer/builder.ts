// Builder mode — chat-driven app generation, wired live to:
//   - the centraid agent (window.CentraidApi.startAgent / promptAgent / onAgentEvent)
//   - the project folder on disk (readProjectFiles for the Code tab)
//   - the openclaw centraid plugin (publish, listVersions, activateVersion)
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
  type DeviceKey = 'mobile' | 'desktop';

  // Inline SVGs for icons not in @centraid/design-tokens. Kept tiny so they
  // can live next to the topbar buttons that need them.
  const SidebarIcon = (size = 16): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>`;
  const ExternalIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>`;
  const RefreshIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.3L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 21v-5h5"/></svg>`;
  const SmartphoneIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>`;
  const MonitorIcon = (size = 13): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
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
  // Per-extension file glyphs. Defaults to a generic page outline.
  function fileIcon(path: string, size = 14): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'].includes(ext)) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg>`;
    }
    if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 8 5 12 9 16"/><polyline points="15 8 19 12 15 16"/></svg>`;
    }
    if (['css', 'scss', 'sass', 'less'].includes(ext)) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;
    }
    if (['json', 'toml', 'yaml', 'yml'].includes(ext) || path.startsWith('.env')) {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`;
    }
    if (ext === 'md') {
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>`;
    }
    // generic page
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="14 3 14 9 20 9"/></svg>`;
  }

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

  function shortVersionTitle(v: { versionId: string; declaredVersion?: string }): string {
    if (v.declaredVersion) return v.declaredVersion;
    // versionId looks like v_2026-05-08T14-30-00-000Z_a1b2c3
    const m = /v_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2})-/.exec(v.versionId);
    return m ? m[1]!.replace('T', ' ') : v.versionId.slice(0, 24);
  }

  function openBuilder(opts: BuilderOptions): () => void {
    const { root, el, onExit, initialPrompt, appContext, onAddToHome } = opts;

    const isUpdateMode = !!opts.projectId;
    const isNewBuild = !isUpdateMode && !!initialPrompt;
    const projName = appContext?.name || (isNewBuild ? 'New app' : 'Untitled');
    const projColor = appContext?.color || (window.ICON_PALETTE?.rose ?? '#5847e0');
    const projIcon: IconNameType = appContext?.iconKey || 'Sparkle';

    // ---------- State ----------
    let projectId: string | undefined = opts.projectId;
    let chat: ChatMsg[] = [];
    let tab: Tab = 'preview';
    let chatView = 'chat' as ChatView;
    let sidebarOpen = true;
    let previewDevice = 'mobile' as DeviceKey;
    let generating = false;
    let publishing = false;
    let lastPublishedVersionId: string | undefined;
    let unsubscribeAgent: (() => void) | null = null;
    let liveUrl: string | undefined;
    // URL-bar state — populated by renderPreview() each time it resolves a src.
    let currentPreviewSrc: string | undefined;
    let currentPreviewKind: 'live' | 'local' | undefined;
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
    const titlebar = el('div', { class: 'titlebar' }, [
      el('span', { class: 'wordmark', onClick: handleExit, style: { cursor: 'pointer' } }, 'M'),
      el('span', { class: 'crumb', onClick: handleExit, style: { cursor: 'pointer' } }, 'Centraid'),
      el('span', { class: 'crumb-sep' }, '/'),
      el('span', {}, isUpdateMode ? `Editing ${projName}` : 'Builder'),
    ]);

    const primaryBtn = el('button', { class: 'btn btn-primary' });
    primaryBtn.innerHTML = Icon.Plus({ size: 13 }) + '<span>Add to home</span>';
    primaryBtn.addEventListener('click', () => {
      void handlePublish({ andAddToHome: isNewBuild });
    });
    if (isUpdateMode) {
      primaryBtn.innerHTML = (Icon.Save ? Icon.Save({ size: 13 }) : '') + '<span>Save</span>';
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

    const projSubtitleEl = el(
      'span',
      {},
      isUpdateMode ? 'Editing existing app' : 'Designing your new app',
    );

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

    // Sidebar toggle — collapses the whole chat pane so the preview gets
    // the full canvas. Sets data-sidebar on .builder-body.
    const sidebarBtn = el('button', {
      'aria-label': 'Toggle sidebar',
      class: 'topbar-icon-btn',
      'data-active': String(sidebarOpen),
      trustedHtml: SidebarIcon(16),
      title: 'Toggle sidebar',
      onClick: () => {
        sidebarOpen = !sidebarOpen;
        body.dataset.sidebar = sidebarOpen ? 'open' : 'closed';
        refreshTopbarToggles();
      },
    });

    // URL bar group — device toggle + current preview URL + open-in-new-tab + reload.
    // Visibility is bound to tab === 'preview'; populated by renderUrlbar().
    const deviceMobileBtn = el('button', {
      'aria-label': 'Mobile',
      class: 'urlbar-device-btn',
      'data-active': String(previewDevice === 'mobile'),
      title: 'Mobile preview',
      trustedHtml: SmartphoneIcon(13),
      onClick: () => {
        if (previewDevice === 'mobile') return;
        previewDevice = 'mobile';
        if (tab === 'preview') renderRight();
        refreshTopbarToggles();
      },
    });
    const deviceDesktopBtn = el('button', {
      'aria-label': 'Desktop',
      class: 'urlbar-device-btn',
      'data-active': String(previewDevice === 'desktop'),
      title: 'Desktop preview',
      trustedHtml: MonitorIcon(13),
      onClick: () => {
        if (previewDevice === 'desktop') return;
        previewDevice = 'desktop';
        if (tab === 'preview') renderRight();
        refreshTopbarToggles();
      },
    });
    const urlbarKindDot = el('span', {
      class: 'urlbar-kind',
      'data-kind': 'none',
      title: 'No preview',
    });
    const urlbarPath = el('span', { class: 'urlbar-path' }, '—');
    const urlbarOpenBtn = el('button', {
      'aria-label': 'Open in browser',
      class: 'urlbar-action-btn',
      trustedHtml: ExternalIcon(13),
      title: 'Open in browser',
      onClick: () => {
        if (currentPreviewSrc) window.open(currentPreviewSrc, '_blank');
      },
    });
    const urlbarReloadBtn = el('button', {
      'aria-label': 'Reload preview',
      class: 'urlbar-action-btn',
      trustedHtml: RefreshIcon(13),
      title: 'Reload preview',
      onClick: () => {
        if (tab === 'preview') renderRight();
      },
    });
    const urlbar = el('div', { class: 'urlbar' }, [
      el('div', { class: 'urlbar-device' }, [deviceMobileBtn, deviceDesktopBtn]),
      el('div', { class: 'urlbar-field' }, [urlbarKindDot, urlbarPath]),
      urlbarOpenBtn,
      urlbarReloadBtn,
    ]);
    const urlbarSlot = el('div', { class: 'urlbar-slot' }, [urlbar]);

    const topbar = el('div', { class: 'builder-topbar' }, [
      el('div', { class: 'builder-topbar-left' }, [
        el('button', {
          'aria-label': 'Back',
          class: 'btn-icon',
          trustedHtml: Icon.ArrowLeft({ size: 16 }),
          onClick: handleExit,
        }),
        projIconEl,
        el('div', { class: 'proj-name' }, [el('b', {}, projName), projSubtitleEl]),
      ]),
      el('div', { class: 'topbar-toggles' }, [historyBtn, sidebarBtn]),
      el(
        'div',
        { class: 'mode-tabs' },
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
              renderUrlbar();
            },
          });
          btn.innerHTML = `${renderIcon()}<span>${label}</span>`;
          return btn;
        }),
      ),
      urlbarSlot,
      el('div', { class: 'builder-topbar-right' }, [
        el('button', { class: 'btn btn-ghost' }, 'Share'),
        primaryBtn,
      ]),
    ]);

    function refreshTabs(): void {
      const keys: Tab[] = tabDefs.map(([k]) => k);
      topbar.querySelectorAll('.mode-tab').forEach((b, i) => {
        (b as HTMLElement).dataset.active = String(tab === keys[i]);
      });
    }

    // Keep the topbar toggle buttons (history, sidebar, device) and URL-bar
    // visibility in sync with state. Called whenever any of those changes.
    function refreshTopbarToggles(): void {
      historyBtn.dataset.active = String(chatView === 'history');
      sidebarBtn.dataset.active = String(sidebarOpen);
      deviceMobileBtn.dataset.active = String(previewDevice === 'mobile');
      deviceDesktopBtn.dataset.active = String(previewDevice === 'desktop');
      urlbarSlot.dataset.visible = String(tab === 'preview');
    }

    function renderUrlbar(): void {
      const has = !!currentPreviewSrc;
      urlbar.dataset.empty = String(!has);
      urlbarKindDot.dataset.kind = currentPreviewKind ?? 'none';
      urlbarKindDot.title =
        currentPreviewKind === 'live'
          ? 'Live (gateway)'
          : currentPreviewKind === 'local'
            ? 'Local files'
            : 'No preview';
      urlbarPath.textContent = has ? formatPreviewUrl(currentPreviewSrc!) : 'No preview yet';
      urlbarPath.title = currentPreviewSrc ?? '';
      (urlbarOpenBtn as HTMLButtonElement).disabled = !has;
      (urlbarReloadBtn as HTMLButtonElement).disabled = tab !== 'preview';
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

    function setSubtitle(text: string): void {
      projSubtitleEl.textContent = text;
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
    const rightPane = el('div', { class: 'right-pane' });
    body.append(chatPane);
    body.append(rightPane);

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
        const wrap = el('div', {
          class: 'tool-group',
          'data-open': String(m.open),
          'data-running': String(isRunning),
          'data-error': String(hasError),
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
      // AI message — preserve paragraphs from the streaming text.
      const para = el('div', { class: 'msg-ai-text' });
      const text = m.text || (m.streaming ? '…' : '');
      text.split('\n\n').forEach((p) => para.append(el('p', {}, p)));
      return el('div', { class: 'msg-ai' }, [para]);
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
          class: 'input-pill',
          trustedHtml: Icon.Plus({ size: 14 }),
          title: 'Attach',
        }),
        el('button', { class: 'input-pill', title: 'Open project folder' }, 'Open folder'),
        el('div', { class: 'spacer' }),
        sendBtn,
      ]);
      // Wire "Open folder" pill to opening the project on disk.
      const openFolderBtn = controls.querySelectorAll('.input-pill')[1] as HTMLElement;
      openFolderBtn.addEventListener('click', () => {
        if (projectId) void Api().openProjectFolder({ id: projectId });
      });

      const wrap = el('div', { class: 'chat-input' }, [ta, controls]);
      inputWrap.append(wrap);
    }

    // ---------- Chat pane swap (chat ↔ history) ----------
    function renderChatPane(): void {
      chatPane.innerHTML = '';
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
        chatPane.append(head);
        chatPane.append(list);
        void renderHistoryInto(list);
        return;
      }
      // Default: live chat view. Recreate fresh containers; renderChat /
      // renderInput repopulate them.
      chatScroll = el('div', { class: 'chat-scroll' });
      inputWrap = el('div', { class: 'chat-input-wrap' });
      chatPane.append(chatScroll);
      chatPane.append(inputWrap);
      renderChat();
      renderInput();
    }

    // ---------- Right pane ----------
    function renderRight(): void {
      rightPane.innerHTML = '';
      rightPane.classList.remove('preview-pane', 'has-phone');
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
      return el('iframe', {
        src,
        style: { border: '0', height: '100%', width: '100%' },
        sandbox: PREVIEW_SANDBOX,
        referrerpolicy: 'no-referrer',
      }) as HTMLIFrameElement;
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
      // `has-phone` styles the pane as the dotted-grid backdrop the phone
      // frame sits on. The desktop view doesn't want that — it wants the
      // preview-stage to flex-stretch normally — so apply it conditionally.
      rightPane.classList.add('preview-pane');
      if (previewDevice === 'mobile') rightPane.classList.add('has-phone');

      const resolved = projectId ? await resolvePreviewSrc() : undefined;
      // Tell the topbar URL bar what we're showing (or that we have nothing).
      currentPreviewSrc = resolved?.src;
      currentPreviewKind = resolved?.kind;
      renderUrlbar();

      if (!resolved) {
        const empty = el('div', { class: 'empty' });
        empty.innerHTML = `
          <p><b>Nothing to preview yet.</b></p>
          <p style="margin-top: 6px; opacity: .7">
            The preview shows your app's local files as soon as the agent
            writes an <code>index.html</code>. Click <b>${isNewBuild ? 'Add to home' : 'Save'}</b> to publish to the gateway once you're happy.
          </p>`;
        rightPane.append(empty);
        return;
      }

      const stage = el('div', { class: 'preview-stage' });
      const cardClass =
        previewDevice === 'mobile' ? 'preview-card preview-card-mobile' : 'preview-card';
      const card = el('div', { class: cardClass });
      card.style.setProperty('--accent-color', projColor as string);
      card.append(makePreviewFrame(resolved.src));
      stage.append(card);
      rightPane.append(stage);
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
      rightPane.append(codePane);

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
        const head = el('div', { class: 'code-viewer-head' }, [
          el('span', { class: 'code-viewer-path' }, file.path),
          el(
            'span',
            { class: 'code-viewer-meta' },
            `${file.content.split('\n').length} lines · read-only`,
          ),
        ]);
        const body = el('div', { class: 'code-body' });
        const lines = file.content.split('\n');
        const gutter = el('div', { class: 'code-gutter' });
        lines.forEach((_, i) => gutter.append(el('div', {}, String(i + 1))));
        const text = el('pre', { class: 'code-text' });
        text.innerHTML = tokenize(file.content, languageHint(file.path));
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
              el('span', {
                class: 'code-tree-icon',
                trustedHtml: fileIcon(node.path, 13),
              }),
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
        walk(visible, 0);

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
        ['users', 'Users', UsersIcon, false],
        ['storage', 'Storage', StorageIcon, false],
        ['secrets', 'Secrets', SecretsIcon, false],
        ['functions', 'Edge functions', FunctionsIcon, false],
        ['sql', 'SQL editor', SqlIcon, false],
        ['logs', 'Logs', LogsIcon, false],
      ];

      const cloudPane = el('div', { class: 'cloud-pane' });
      const rail = el('div', { class: 'cloud-rail' });
      const stage = el('div', { class: 'cloud-stage' });
      cloudPane.append(rail);
      cloudPane.append(stage);
      rightPane.append(cloudPane);

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

      const drawRail = (): void => {
        rail.innerHTML = '';
        for (const [key, label, renderIcon, ready] of sections) {
          const btn = el('button', {
            class: 'cloud-rail-item',
            'data-active': String(active === key),
            'data-ready': String(ready),
            onClick: () => {
              if (active === key) return;
              active = key;
              openTable = undefined;
              drawRail();
              drawStage();
            },
          });
          const badge = ready
            ? ''
            : '<span class="cloud-rail-badge" title="Not yet available">Soon</span>';
          btn.innerHTML = `${renderIcon(14)}<span class="cloud-rail-label">${escapeHtml(label)}</span>${badge}`;
          rail.append(btn);
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
        if (active === 'database' || active === 'overview') drawStage();
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
        if (active === 'overview') drawStage();
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
        const def = sections.find(([k]) => k === active);
        const title = def?.[1] ?? '';
        const subtitle =
          active === 'database'
            ? 'Tables, columns, and indexes from your live app database.'
            : active === 'overview'
              ? 'Status of your app on the gateway.'
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
        }
        stage.append(head);

        if (active === 'overview') {
          drawOverview();
        } else if (active === 'database') {
          drawDatabase();
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

        const grid = el('div', { class: 'cloud-stat-grid' });

        const liveCard = el('div', { class: 'cloud-stat-card' });
        liveCard.innerHTML = liveUrl
          ? `<div class="cloud-stat-label">Live URL</div><div class="cloud-stat-value cloud-stat-mono">${escapeHtml(formatPreviewUrl(liveUrl))}</div>`
          : '<div class="cloud-stat-label">Live URL</div><div class="cloud-stat-value cloud-stat-muted">Not published</div>';
        grid.append(liveCard);

        const versionCard = el('div', { class: 'cloud-stat-card' });
        if (versionsCache === 'pending' || versionsCache === undefined) {
          versionCard.innerHTML =
            '<div class="cloud-stat-label">Versions</div><div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (versionsCache === 'error') {
          versionCard.innerHTML =
            '<div class="cloud-stat-label">Versions</div><div class="cloud-stat-value cloud-stat-muted">—</div>';
        } else {
          const v = versionsCache;
          versionCard.innerHTML = `<div class="cloud-stat-label">Versions</div><div class="cloud-stat-value">${v.versions.length}</div><div class="cloud-stat-sub">${v.activeVersion ? `Active: ${escapeHtml(v.activeVersion.slice(0, 18))}…` : 'No active version'}</div>`;
        }
        grid.append(versionCard);

        const schemaCard = el('div', { class: 'cloud-stat-card' });
        if (schemaCache === 'pending' || schemaCache === undefined) {
          schemaCard.innerHTML =
            '<div class="cloud-stat-label">Schema version</div><div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (schemaCache === 'error') {
          schemaCard.innerHTML = `<div class="cloud-stat-label">Schema version</div><div class="cloud-stat-value cloud-stat-muted">Unavailable</div><div class="cloud-stat-sub">${escapeHtml(schemaError ?? 'gateway error')}</div>`;
        } else if (!schemaCache) {
          schemaCard.innerHTML =
            '<div class="cloud-stat-label">Schema version</div><div class="cloud-stat-value cloud-stat-muted">—</div><div class="cloud-stat-sub">Publish to create the database</div>';
        } else {
          schemaCard.innerHTML = `<div class="cloud-stat-label">Schema version</div><div class="cloud-stat-value">v${schemaCache.schemaVersion}</div>`;
        }
        grid.append(schemaCard);

        const tableCard = el('div', { class: 'cloud-stat-card' });
        if (schemaCache === 'pending' || schemaCache === undefined) {
          tableCard.innerHTML =
            '<div class="cloud-stat-label">Tables</div><div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (!schemaCache || schemaCache === 'error') {
          tableCard.innerHTML =
            '<div class="cloud-stat-label">Tables</div><div class="cloud-stat-value cloud-stat-muted">—</div>';
        } else {
          const s = schemaCache;
          tableCard.innerHTML = `<div class="cloud-stat-label">Tables</div><div class="cloud-stat-value">${s.tables.length}</div><div class="cloud-stat-sub">${s.indexes.length} indexes · ${s.views.length} views</div>`;
        }
        grid.append(tableCard);

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
        // Show the divider immediately. Real chat history (and a fallback
        // placeholder for first-time opens) is appended once the persisted
        // session loads below.
        chat = [{ kind: 'divider', text: 'Editing existing project' }];
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
              text: `Loaded "${projName}". No prior chat — describe a change to get started.`,
            },
          ]);
        }
        renderChat();
        setSubtitle('Editing existing app · ready');
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
        setSubtitle(`Designing your new app · ${id}`);
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
    async function handlePublish(opts: { andAddToHome: boolean }): Promise<void> {
      if (!projectId) {
        showToast('No project to publish');
        return;
      }
      if (publishing) return;
      publishing = true;
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
        if (opts.andAddToHome && onAddToHome) {
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
        primaryBtn.removeAttribute('disabled');
      }
    }

    function handleExit(): void {
      onExit();
    }

    // ---------- Mount ----------
    root.append(titlebar);
    const builder = el('div', { class: 'builder' }, [topbar, body]);
    root.append(builder);

    // renderChatPane() mounts chat-scroll + input the first time, then
    // renderChat()/renderInput() repaint via the references it sets up.
    renderChatPane();
    renderRight();
    refreshTopbarToggles();
    renderUrlbar();

    // Kick off async setup.
    void bootstrap();

    // Cleanup
    return () => {
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
