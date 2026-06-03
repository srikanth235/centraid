// Builder mode — chat-driven app generation, wired live to:
//   - the gateway's unified chat (streamTurn → POST /centraid/<id>/_turn SSE):
//     the turn runs server-side in the app's draft worktree with the union of
//     tools, so the builder's "edit my app" chat and the app view's data chat
//     are one surface on one transport (issue #141, Phase 3)
//   - the app folder on disk (readAppFiles for the Code tab)
//   - the openclaw centraid plugin (publish, listVersions, activateVersion)
// governance: allow-repo-hygiene file-size-limit builder-mode pending split into chat/preview/code modules
//
// Layout (modeled on Lovable's IA):
//   Topbar:    [back][app] [history-btn][sidebar-btn] {Preview|Code} [device|URL|↗|⟳] [Share][primary]
//   Chat pane: swaps between live chat (chatView='chat') and version history
//              (chatView='history'). Sidebar-btn collapses the whole pane.
//   Right pane: Preview (iframe → gateway draft URL: /centraid/_draft/<sid>/<id>/)
//               or Code (app files, syntax-highlighted).

import {
  appSchema,
  appTableRows,
  appQuery,
  appLogs,
  appLiveUrl,
  listVersions,
  activateVersion,
  listAutomations,
  runAutomationNow,
  readAutomationRun,
  listAutomationRuns,
  readAppFiles,
  writeAppFile,
  draftPreviewUrl,
  publish,
  createApp,
  updateAppMeta,
  setAutomationEnabled,
  deleteAutomation,
  streamTurn,
  createConversation,
  listConversations,
  type TurnStreamEvent,
} from './gateway-client.js';

(function () {
  // A single tool invocation. Multiple of these are consolidated into a
  // toolGroup chat bubble (see below).
  type ToolCall = {
    id: string;
    tool: string;
    summary?: string;
    state: 'running' | 'ok' | 'error';
  };

  type ConversationMsg =
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

  type Tab = 'preview' | 'code' | 'cloud' | 'config' | 'runs';
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
  // Paperclip glyph for the chat composer's attach control — the shared
  // icon set has no paperclip, so it lives inline here.
  const PaperclipIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
  // File-with-edit glyph for the change card that surfaces below tool-group
  // pills when the agent wrote files. Page outline + a small pen overlay.
  const FileEditIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><polyline points="14 3 14 9 20 9"/><path d="M18 13l3 3-5 5h-3v-3z"/></svg>`;
  // Cloud-surface icons. The Cloud surface is a Lovable-style data-browser
  // panel reached from the sidebar; these glyphs label its left-rail
  // sub-sections (Database, Users, Storage, etc.).
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
  const AutomationsIcon = (size = 14): string =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>`;
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

  function generateAppId(seed: string): string {
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

  // ---------- Cron (automation builder) ----------
  // A 5-field cron is "min hour day-of-month month day-of-week" in UTC.
  // The automation config pane shows a plain-English gloss + the next
  // few fire times; no cron library is on the renderer, so this is a
  // minimal self-contained evaluator covering `*`, `*/n`, lists, ranges,
  // and the named day/month tokens the manifest may carry.
  const CRON_DOW: Record<string, number> = {
    SUN: 0,
    MON: 1,
    TUE: 2,
    WED: 3,
    THU: 4,
    FRI: 5,
    SAT: 6,
  };
  const CRON_MON: Record<string, number> = {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  };

  function cronFieldMatch(
    field: string,
    value: number,
    min: number,
    max: number,
    names: Record<string, number>,
  ): boolean {
    for (let part of field.split(',')) {
      part = part.trim();
      let step = 1;
      const slash = part.indexOf('/');
      if (slash >= 0) {
        step = parseInt(part.slice(slash + 1), 10) || 1;
        part = part.slice(0, slash);
      }
      let lo = min;
      let hi = max;
      if (part !== '*' && part !== '?' && part !== '') {
        const resolve = (t: string): number => {
          const named = names[t.trim().toUpperCase()];
          return named !== undefined ? named : parseInt(t, 10);
        };
        if (part.includes('-')) {
          const [a, b] = part.split('-');
          lo = resolve(a ?? '');
          hi = resolve(b ?? '');
        } else {
          lo = resolve(part);
          hi = lo;
        }
      }
      if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
      if (value < lo || value > hi) continue;
      if ((value - lo) % step === 0) return true;
    }
    return false;
  }

  /** Next `count` fire times (UTC) for a 5-field cron, or `[]` if unparseable. */
  function cronNextRuns(expr: string, count: number, from: Date = new Date()): Date[] {
    const f = expr.trim().split(/\s+/);
    if (f.length !== 5) return [];
    const [minF, hourF, domF, monF, dowF] = f as [string, string, string, string, string];
    const out: Date[] = [];
    const d = new Date(
      Date.UTC(
        from.getUTCFullYear(),
        from.getUTCMonth(),
        from.getUTCDate(),
        from.getUTCHours(),
        from.getUTCMinutes() + 1,
      ),
    );
    const cap = 366 * 24 * 60; // step at most one year of minutes
    for (let i = 0; i < cap && out.length < count; i++) {
      const domStar = domF === '*' || domF === '?';
      const dowStar = dowF === '*' || dowF === '?';
      const domOk = cronFieldMatch(domF, d.getUTCDate(), 1, 31, {});
      const dow = d.getUTCDay();
      const dowOk =
        cronFieldMatch(dowF, dow, 0, 7, CRON_DOW) ||
        cronFieldMatch(dowF, dow === 0 ? 7 : dow, 0, 7, CRON_DOW);
      // Standard cron: when both day fields are restricted they OR;
      // when one is `*` the other governs.
      const dayOk = domStar && dowStar ? true : domStar ? dowOk : dowStar ? domOk : domOk || dowOk;
      if (
        dayOk &&
        cronFieldMatch(minF, d.getUTCMinutes(), 0, 59, {}) &&
        cronFieldMatch(hourF, d.getUTCHours(), 0, 23, {}) &&
        cronFieldMatch(monF, d.getUTCMonth() + 1, 1, 12, CRON_MON)
      ) {
        out.push(new Date(d));
      }
      d.setUTCMinutes(d.getUTCMinutes() + 1);
    }
    return out;
  }

  /** Best-effort plain-English gloss of a 5-field cron expression. */
  function describeCron(expr: string): string {
    const t = expr.trim().replace(/\s+/g, ' ');
    const known: Record<string, string> = {
      '0 9 * * *': 'Every day at 09:00 UTC',
      '0 0 * * *': 'Every day at midnight UTC',
      '0 * * * *': 'Every hour, on the hour',
      '*/30 * * * *': 'Every 30 minutes',
      '*/15 * * * *': 'Every 15 minutes',
      '*/5 * * * *': 'Every 5 minutes',
      '0 9 * * 1-5': 'Weekdays at 09:00 UTC',
      '0 9 * * MON-FRI': 'Weekdays at 09:00 UTC',
      '0 9 * * 1': 'Every Monday at 09:00 UTC',
    };
    if (known[t]) return known[t];
    const f = t.split(' ');
    const pad2 = (n: string): string => n.padStart(2, '0');
    if (f.length === 5) {
      if (
        /^\d+$/.test(f[0]!) &&
        /^\d+$/.test(f[1]!) &&
        f[2] === '*' &&
        f[3] === '*' &&
        f[4] === '*'
      ) {
        return `Every day at ${pad2(f[1]!)}:${pad2(f[0]!)} UTC`;
      }
      if (f[0]!.startsWith('*/') && f.slice(1).every((x) => x === '*')) {
        return `Every ${f[0]!.slice(2)} minutes`;
      }
      if (/^\d+$/.test(f[0]!) && f.slice(1).every((x) => x === '*')) {
        return `Every hour at :${pad2(f[0]!)}`;
      }
    }
    return `Cron: ${t}`;
  }

  function openBuilder(opts: BuilderOptions): () => void {
    const { root, el, onExit, initialPrompt, appContext, onAddToHome, onMetaChange } = opts;

    const isUpdateMode = !!opts.appId;
    const isNewBuild = !isUpdateMode && !!initialPrompt;
    // Automations are first-class apps with their own builder mode:
    // the right pane shows a read-only config view of `automation.json`
    // (which the chat agent fills) instead of an app preview iframe.
    const appKind: 'app' | 'automation' = opts.appKind ?? 'app';
    const isAutomation = appKind === 'automation';
    let projName = appContext?.name || (isNewBuild ? 'New app' : 'Untitled');
    // Description still rides on app.json — the inline editor was removed
    // when the subtitle slot became the read-only status row. The value
    // continues to surface via appContext.desc to the home grid.
    const projColor = appContext?.color || (window.ICON_PALETTE?.rose ?? '#5847e0');
    const projIcon: IconNameType = appContext?.iconKey || 'Sparkle';

    // ---------- State ----------
    let appId: string | undefined = opts.appId;
    let chat: ConversationMsg[] = [];
    let tab: Tab = isAutomation ? 'config' : 'preview';
    // Latest `automation.json` snapshot, re-read after each agent turn so
    // the config pane reflects what the agent wrote. Automation mode only.
    let automationRow: CentraidAutomationRow | undefined;
    // True while a run-now / enable IPC is in flight (disables the controls).
    let automationBusy = false;
    let chatView = 'chat' as ChatView;
    let previewDevice = 'mobile' as DeviceKey;
    let generating = false;
    let publishing = false;
    let lastPublishedVersionId: string | undefined;
    // The gateway chat session this builder streams turns to. Reused across
    // turns so the gateway resumes the same adapter thread; lazily created on
    // first turn. Null until then.
    let conversationId: string | null = null;
    // Abort handle for the in-flight chat turn (Stop / unmount).
    let agentAbort: AbortController | null = null;
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
    // app. Consumed by turn_end to refresh the preview iframe so the
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
    // Mirrors the fields coding-agent tools commonly emit (path /
    // command / pattern). Falls back gracefully for custom or unknown tools.
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

    // Primary action — always "Publish" with the Share/upload glyph in
    // both new-build and update modes (refined proposal RefinedBuilder).
    // Update mode reuses the same publish flow; the gateway semantics
    // (uploading a new version) are identical, so the label unifies.
    const primaryBtn = el('button', { class: 'btn btn-primary cd-tl-publish' });
    if (isAutomation) {
      // Automation draft → "Enable" turns on the schedule; once enabled
      // the button flips to "Disable". paintAutomationPrimary() owns the
      // label and is re-run whenever the manifest snapshot changes.
      paintAutomationPrimary();
      primaryBtn.addEventListener('click', () => {
        void handleToggleEnabled();
      });
    } else {
      primaryBtn.innerHTML = Icon.Share({ size: 11 }) + '<span>Publish</span>';
      primaryBtn.addEventListener('click', () => {
        void handlePublish();
      });
    }

    // Titlebar app-icon tile — a gradient finish from the app color,
    // matching how app icons are tiled on Home (renderAppCard) and in the
    // App-view brand chip. ~20px to sit inside the identity pill.
    const projIconEl = el('div', {
      class: 'cd-tl-app-icon',
      trustedHtml: (Icon[projIcon] || Icon.Sparkle)({ size: 11, strokeWidth: 1.9 }),
    });
    function paintProjIcon(): void {
      const finish = window.CentraidTokens.tileFinish(projColor as string, 'gradient');
      projIconEl.style.background = finish.background;
      projIconEl.style.color = finish.glyphColor;
      if (finish.boxShadow) projIconEl.style.boxShadow = finish.boxShadow;
    }
    paintProjIcon();

    // Read-only status badge — a compact uppercase-mono pill with a
    // pulsing dot, sitting inside the titlebar identity lockup (refined
    // proposal RefinedBuilder). The dynamic text (Draft / Editing… /
    // Publishing… / Live · v…) is composed by paintStatus(); only the
    // sync-state colour is driven by the parent's [data-state].
    const projStatusDot = el('span', { class: 'cd-tl-status-dot' });
    const projStatusText = el('span', { class: 'cd-tl-status-text' }, 'Draft');
    const projSubtitleEl = el('span', { 'data-state': 'idle-draft', class: 'cd-tl-status' }, [
      projStatusDot,
      projStatusText,
    ]);
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
      if (isAutomation) {
        projStatusText.textContent = generating
          ? 'Editing…'
          : automationBusy
            ? 'Working…'
            : automationRow?.enabled
              ? 'Enabled'
              : 'Draft';
        return;
      }
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
    // §B3 — the pane toggle is Preview/Code only. Cloud is a sidebar
    // destination (§G2), reached via the expanded app's Cloud child.
    const tabDefs: [Tab, string, () => string][] = isAutomation
      ? [
          ['config', 'Config', () => Icon.Settings({ size: 13 })],
          ['runs', 'Runs', () => Icon.History({ size: 13 })],
        ]
      : [
          ['preview', 'Preview', () => Icon.Eye({ size: 13 })],
          ['code', 'Code', () => Icon.Code({ size: 13 })],
          ['cloud', 'Cloud', () => Icon.Bolt({ size: 13 })],
        ];

    // History toggle — swaps the chat pane between live chat and version
    // history (matches Lovable; keeps the right pane on Preview/Code so the
    // user can still see the rendered app while browsing past versions).
    const historyBtn = el('button', {
      'aria-label': 'View history',
      class: 'cd-tb-btn',
      'data-active': String(chatView === 'history'),
      trustedHtml: Icon.History({ size: 14 }),
      title: 'View history',
      onClick: () => {
        chatView = chatView === 'history' ? 'chat' : 'history';
        renderChatPane();
        refreshTopbarToggles();
      },
    });

    // Automations have no gateway versions — hide the version-history
    // toggle in automation mode (the chat pane keeps the conversation).
    if (isAutomation) historyBtn.style.display = 'none';

    // The window chrome (cd-tl-main) owns its own sidebar toggle — the
    // duplicate in the old cd-app-strip is gone with the strip itself.
    // `sidebarOpen` is now flipped via Chrome.setSidebarOpen.

    // Device segmented control — toggles the preview iframe between
    // mobile / tablet / desktop framing. Lives in the right-pane toolbar
    // (`rb-toolbar`) and is hidden when the active tab isn't Preview
    // (gated by `.rb-toolbar[data-tab]`).
    const deviceMobileBtn = el('button', {
      'aria-label': 'Mobile',
      class: 'urlbar-device-btn',
      'data-active': String(previewDevice === 'mobile'),
      title: 'Mobile preview',
      // Icon-only segmented device control (refined proposal RBPaneToolbar);
      // the `title` attr carries the tooltip.
      trustedHtml: SmartphoneIcon(13),
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
      trustedHtml: TabletIcon(13),
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
      trustedHtml: MonitorIcon(13),
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

    // §B3 — preview URL pill. A sync-state dot, the trimmed preview URL in
    // mono, and a reload button. The full URL rides on the pill's `title`
    // attribute; renderPreview() keeps the text + dot state in sync.
    const previewUrlDot = el('span', { class: 'rb-url-dot', 'data-state': 'idle' });
    const previewUrlText = el('span', { class: 'rb-url-text' }, 'No preview');
    const previewRefreshBtn = el('button', {
      'aria-label': 'Reload preview',
      class: 'rb-url-refresh',
      title: 'Reload preview',
      trustedHtml: RefreshIcon(13),
      onClick: () => {
        if (tab === 'preview') renderRight();
      },
    });
    const previewUrlPill = el('div', { class: 'rb-url' }, [
      previewUrlDot,
      previewUrlText,
      previewRefreshBtn,
    ]);

    // Inline-editable title + description. Edits persist to
    // `app.json#{name,description}` via the updateAppMeta IPC and also
    // fire `onMetaChange` so the home pane can refresh its tile metadata
    // without waiting for a re-publish. In new-build mode no app file
    // exists yet, so we only update local state — `createApp` picks up
    // the latest values when the first prompt is sent.
    const projNameEl = el(
      'b',
      { contenteditable: 'plaintext-only', spellcheck: 'false' },
      projName,
    );
    projNameEl.setAttribute('title', 'Click to rename');
    // An automation's name lives in `automation.json` — the agent owns
    // it, so the builder title is read-only here (renamed via chat).
    if (isAutomation) {
      projNameEl.setAttribute('contenteditable', 'false');
      projNameEl.removeAttribute('title');
    }
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
      if (appId) {
        void updateAppMeta({ id: appId, name: next }).catch((err: unknown) => {
          // Roll back if persistence fails so the UI stays truthful.
          projName = previous;
          projNameEl.textContent = previous;
          crumbProjName.textContent = isUpdateMode ? `Editing ${previous}` : 'Builder';
          showToast(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        if (onMetaChange) onMetaChange({ appId, name: next });
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
        // Icon-only toggle (refined proposal RBPaneToggle); the `title` +
        // `aria-label` carry the Preview / Code semantics.
        btn.innerHTML = renderIcon();
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
      else if (isAutomation && automationRow?.enabled) state = 'idle-live';
      projSubtitleEl.dataset.state = state;
      paintStatus();
    }

    // In-pane builder header — lives at the top of the chat pane and owns
    // the app-level affordances (icon, name, status, more menu, Publish).
    // App identity belongs to the chat pane (its conversation), not the
    // global window chrome; the chrome row only carries view-context controls
    // (mode tabs, device pill).
    const moreBtn = el('button', {
      'aria-label': 'More app actions',
      class: 'cd-tb-btn',
      title: 'More',
      // Wired in a future commit (Share, Rename, Edit description, etc.);
      // for now it's a visual placeholder so the header reads complete.
      trustedHtml: Icon.MoreHoriz({ size: 14 }),
    });

    // Titlebar identity lockup — a soft ink-washed pill carrying the
    // gradient app-icon, the editable app name, and the status
    // badge. Lands in `.cd-tl-nav` (via `titlebarLead`) so it hugs the
    // back/forward arrows, matching the refined proposal RefinedBuilder.
    // The chat pane no longer carries a header row of its own.
    const builderIdentity = el('span', { class: 'cd-tl-identity' }, [
      projIconEl,
      projNameEl,
      projSubtitleEl,
    ]);
    // Trailing titlebar actions — history, more, and the Publish button.
    const builderActions = el('span', { class: 'cd-tl-builder-actions' }, [
      historyBtn,
      moreBtn,
      primaryBtn,
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
      rbToolbar.dataset.tab = tab;
    }

    // Trim noisy URL prefixes for display while preserving the full URL on
    // hover (set as title attr by the caller). The gateway draft-preview URL
    // (`…/centraid/_draft/<sessionId>/<id>/`) is collapsed to a friendly
    // "Draft preview" label rather than the long internal path.
    function formatPreviewUrl(src: string): string {
      try {
        const u = new URL(src);
        if (u.pathname.includes('/_draft/')) return 'Draft preview';
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
    // The right pane carries its own toolbar (`rb-toolbar`) above the
    // canvas. Backdrop classes (`preview-pane`, `has-phone`) stay on
    // `rightPane` so the dotted wall fills the column. Render functions
    // write into `rightPaneContent`.
    const rightPane = el('div', { class: 'right-pane' });
    // §B3 — right-pane toolbar. Layout mirrors RBPaneToolbar: URL pill at
    // the leading edge, then a flex spacer, then the viewport device pill,
    // an open-in-new-tab button, and the Preview/Code toggle on the
    // trailing edge — controls sitting with the surface they control.
    // `data-tab` gates the preview-only controls (URL pill + device pill).
    const rbShareBtn = el('button', {
      'aria-label': 'Open in new tab',
      class: 'rb-toolbar-share',
      title: 'Open in new tab',
      trustedHtml: Icon.Share({ size: 12 }),
    });
    // Automations have no previewable URL — drop the open-in-new-tab control.
    if (isAutomation) rbShareBtn.style.display = 'none';
    const rbToolbar = el('div', { class: 'rb-toolbar', 'data-tab': tab }, [
      previewUrlPill,
      el('div', { class: 'rb-toolbar-spacer' }),
      devicePill,
      rbShareBtn,
      tabsPill,
    ]);
    const rightPaneContent = el('div', { class: 'right-pane-content' });
    rightPane.append(rbToolbar);
    rightPane.append(rightPaneContent);
    body.append(chatPane);
    body.append(rightPane);

    // chat-scroll + chat-input-wrap are recreated by renderChatPane() each
    // time chatView changes, so the same pane can host either view without
    // leaking listeners. We hold references for renderChat() / renderInput().
    let chatScroll: HTMLElement = el('div', { class: 'chat-scroll' });
    let inputWrap: HTMLElement = el('div', { class: 'chat-input-wrap' });

    function renderMessage(m: ConversationMsg): HTMLElement {
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
      // AI message — flat prose with a small sparkle avatar at the lead
      // (matches RBChat's agent message). The avatar grounds the turn in
      // the conversation; the body reads as plain prose, no bubble.
      const avatar = el('span', {
        class: 'msg-ai-avatar',
        trustedHtml: Icon.Sparkle({ size: 11 }),
      });
      const para = el('div', { class: 'msg-ai-text' });
      const text = m.text || (m.streaming ? '…' : '');
      text.split('\n\n').forEach((p) => para.append(el('p', {}, p)));
      return el('div', { class: 'msg-ai' }, [avatar, para]);
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

    function pushMessage(m: ConversationMsg): number {
      chat = chat.concat([m]);
      renderChat();
      return chat.length - 1;
    }

    function updateMessage(idx: number, patch: Partial<ConversationMsg>): void {
      const at = chat[idx];
      if (!at) return;
      chat = chat.map((m, i) => (i === idx ? ({ ...m, ...patch } as ConversationMsg) : m));
      renderChat();
    }

    // ---------- Input ----------
    function renderInput(): void {
      inputWrap.innerHTML = '';
      const ta = el('textarea', {
        placeholder: 'Describe a change…',
        rows: 1,
      }) as HTMLTextAreaElement;

      const send = (): void => {
        const text = ta.value.trim();
        if (!text || generating || !appId) return;
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
        trustedHtml: Icon.ArrowRight({ size: 14, strokeWidth: 2.5 }),
        onClick: send,
      });

      const controls = el('div', { class: 'chat-input-controls' }, [
        // Composer carries the attach control only (refined proposal RBChat).
        el('button', {
          'aria-label': 'Attach',
          class: 'input-pill input-pill-icon',
          title: 'Attach',
          trustedHtml: PaperclipIcon(14),
        }),
        el('div', { class: 'spacer' }),
        el('span', { class: 'chat-input-kbd' }, '⌘↵'),
        sendBtn,
      ]);

      const wrap = el('div', { class: 'chat-input' }, [ta, controls]);
      // Contextual follow-ups — anchored just above the input under a
      // "Suggested next moves" eyebrow so they read as a labelled group
      // (matches RBChat). Same hardcoded set today; future work can swap
      // in turn-aware suggestions from the agent.
      const followupChips = el('div', { class: 'prompt-starters' });
      for (const suggestion of [
        'Improve the layout',
        'Add saved data',
        'Polish the visual style',
        'Prepare to publish',
      ]) {
        followupChips.append(
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
      inputWrap.append(
        el('div', { class: 'prompt-starters-group' }, [
          el('div', { class: 'prompt-starters-label' }, 'Suggested next moves'),
          followupChips,
        ]),
      );
      inputWrap.append(wrap);
    }

    // The chat pane has no header row of its own — app identity
    // (icon + name + status) and the app actions live in the window
    // titlebar (refined proposal RefinedBuilder). The chat pane is just a
    // body that swaps between live chat and version history.
    const chatBody = el('div', { class: 'chat-body' });
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
      // Automation mode — the right pane is a read-only config view of
      // `automation.json` or the run history, not an app preview. The
      // chat pane always stays visible (the conversation IS the builder).
      if (isAutomation) {
        main.dataset.chat = builderChatOpen ? 'open' : 'closed';
        setShellChatPaneOpen(builderChatOpen);
        if (tab === 'runs') renderRuns();
        else renderConfig();
        return;
      }
      // Code + Cloud are full-focus surfaces — the refined Builder
      // artboards show no chat pane on these tabs, so the file tree /
      // cloud rail + content span the whole body. Preview restores the
      // user's saved chat-pane preference.
      const chatVisible = tab === 'preview' ? builderChatOpen : false;
      main.dataset.chat = chatVisible ? 'open' : 'closed';
      setShellChatPaneOpen(chatVisible);
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
      // stays in sync — same protocol as the running-app view. The
      // shell's named theme is resolved to its 'light' | 'dark' kind so
      // template CSS keyed on `[data-theme='dark']` keeps matching when
      // the user picks a third-party preset (Monokai, Nord, …).
      const html = document.documentElement;
      const shellTheme = html.dataset.theme || 'dark';
      const shellThemeRecord = window.CentraidTokens.themes as Record<
        string,
        { kind: 'light' | 'dark' } | undefined
      >;
      const theme = shellThemeRecord[shellTheme]?.kind ?? 'dark';
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

    async function resolvePreviewSrc(): Promise<{ src: string; kind: 'draft' } | undefined> {
      if (!appId) return undefined;
      // The builder always previews the *draft* worktree (issue #141,
      // Phase 4): the gateway serves the open `desktop-<id>` session under
      // `/centraid/_draft/<sessionId>/<id>/`, so staged chat/file edits show
      // here before an explicit Publish flips them live. The draft is the
      // editing surface, so we never point this iframe at the published live
      // URL — after Publish the draft == live anyway. `available` is false
      // until the draft has an index.html (fresh app mid-generation), which
      // keeps the building skeleton up until the first page is staged.
      try {
        const r = await draftPreviewUrl(appId);
        if (r.available) return { src: r.url, kind: 'draft' };
      } catch {
        /* swallow — show building skeleton below */
      }
      return undefined;
    }

    // §B4 — skeleton phone shown while the agent is still building (before
    // an index.html exists). Replaces the old "Nothing to preview yet"
    // paragraph so the canvas reads as "a screen taking shape", not empty.
    function buildPreviewSkeleton(): HTMLElement {
      const stage = el('div', { class: 'preview-stage' });
      const phone = el('div', { class: 'skel-phone' });
      const screen = el('div', { class: 'skel-phone-screen' });

      screen.append(
        el('div', { class: 'skel-statusbar' }, [
          el('span', {}, '9:41'),
          el('span', { class: 'skel-battery' }),
        ]),
      );

      const skelBody = el('div', { class: 'skel-body' });
      skelBody.append(el('div', { class: 'skel-block skel-block-title' }));
      skelBody.append(el('div', { class: 'skel-block skel-block-sub' }));
      skelBody.append(el('div', { class: 'skel-block skel-block-card' }));
      const grid = el('div', { class: 'skel-grid' });
      for (const _ of Array.from({ length: 28 })) grid.append(el('div', { class: 'skel-cell' }));
      skelBody.append(grid);
      for (const _ of Array.from({ length: 3 })) {
        skelBody.append(el('div', { class: 'skel-block skel-block-row' }));
      }
      screen.append(skelBody);

      phone.append(screen);
      stage.append(phone);
      return stage;
    }

    async function renderPreview(): Promise<void> {
      // `has-phone` styles the pane as the dotted-grid backdrop that mobile
      // and tablet device frames sit on. Desktop wants a plain flex-stretched
      // stage instead, so apply the backdrop conditionally.
      rightPane.classList.add('preview-pane');
      if (previewDevice === 'mobile' || previewDevice === 'tablet') {
        rightPane.classList.add('has-phone');
      }

      const resolved = appId ? await resolvePreviewSrc() : undefined;

      // §B3 — keep the toolbar URL pill in sync with the resolved source.
      if (!resolved) {
        previewUrlText.textContent = 'Building…';
        previewUrlDot.dataset.state = 'building';
        previewUrlPill.removeAttribute('title');
      } else {
        previewUrlText.textContent = formatPreviewUrl(resolved.src);
        previewUrlDot.dataset.state = 'local';
        previewUrlPill.setAttribute('title', resolved.src);
      }

      if (!resolved) {
        // §B4 — render the skeleton phone + an ambient building pill
        // instead of an explanatory paragraph.
        rightPane.classList.add('has-phone');
        rightPaneContent.append(buildPreviewSkeleton());
        rightPaneContent.append(
          el('div', { class: 'preview-building-pill' }, [
            el('span', { class: 'preview-building-dot' }),
            'Building · preview refreshes on save',
          ]),
        );
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

      // Floating "Draft · staged" badge — ambient signal that the iframe
      // reflects the staged draft worktree (served through the gateway),
      // not the published version. An explicit Publish flips it live.
      const badge = el('div', { class: 'preview-live-badge' });
      badge.innerHTML = '<span class="preview-live-dot"></span>Draft · staged';
      rightPaneContent.append(badge);
    }

    // §B5 — editable code workspace. Buffers, open tabs, the active file,
    // and the diff toggle are hoisted out of renderCode() so unsaved edits
    // survive renderRight() re-renders (e.g. the user peeking at Preview
    // and coming back). A buffer's `current` diverging from `original`
    // marks it dirty.
    type CodeLang = 'html' | 'js' | 'ts' | 'css' | 'json' | 'md' | 'other';
    interface CodeBuffer {
      original: string;
      current: string;
      language: CodeLang;
    }
    const codeBuffers = new Map<string, CodeBuffer>();
    const codeOpenTabs: string[] = [];
    let codeActivePath: string | undefined;
    let codeDiffMode = false;

    // Unified line diff (LCS) — drives the Code view's Diff toggle. O(mn)
    // is fine here: app files are capped at 256 KB by readAppFiles.
    type DiffRow = { type: 'same' | 'add' | 'del'; text: string; aNum?: number; bNum?: number };
    function lineDiff(aStr: string, bStr: string): DiffRow[] {
      const a = aStr.split('\n');
      const b = bStr.split('\n');
      const m = a.length;
      const n = b.length;
      const dp: number[][] = Array.from({ length: m + 1 }, () =>
        Array.from<number>({ length: n + 1 }).fill(0),
      );
      for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
          dp[i]![j] =
            a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
        }
      }
      const rows: DiffRow[] = [];
      let i = 0;
      let j = 0;
      let an = 1;
      let bn = 1;
      while (i < m && j < n) {
        if (a[i] === b[j]) {
          rows.push({ type: 'same', text: a[i]!, aNum: an++, bNum: bn++ });
          i++;
          j++;
        } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
          rows.push({ type: 'del', text: a[i]!, aNum: an++ });
          i++;
        } else {
          rows.push({ type: 'add', text: b[j]!, bNum: bn++ });
          j++;
        }
      }
      while (i < m) rows.push({ type: 'del', text: a[i++]!, aNum: an++ });
      while (j < n) rows.push({ type: 'add', text: b[j++]!, bNum: bn++ });
      return rows;
    }

    // Code view — file tree on the left, an editable tabbed editor on the
    // right (§B5). The editor is a transparent <textarea> over a tokenized
    // <pre>, so typing stays live while keeping syntax colour.
    async function renderCode(): Promise<void> {
      const codePane = el('div', { class: 'code-pane' });
      const treeWrap = el('div', { class: 'code-tree' });
      const workspace = el('div', { class: 'code-workspace' });
      codePane.append(treeWrap);
      codePane.append(workspace);
      rightPaneContent.append(codePane);

      if (!appId) {
        workspace.innerHTML = '<div class="empty">No app yet.</div>';
        return;
      }
      const pid = appId;

      let files: Awaited<ReturnType<typeof readAppFiles>> = [];
      try {
        files = await readAppFiles({ id: pid });
      } catch (err) {
        workspace.innerHTML = `<div class="empty">Could not read files: ${escapeHtml(String(err))}</div>`;
        return;
      }

      if (files.length === 0) {
        workspace.innerHTML = '<div class="empty">Empty app.</div>';
        return;
      }

      // Sync clean buffers to the freshest on-disk bytes (the agent may
      // have rewritten files since the last Code visit); leave dirty
      // buffers untouched so unsaved edits are never clobbered.
      for (const f of files) {
        const buf = codeBuffers.get(f.path);
        if (buf && buf.current === buf.original) {
          buf.original = f.content;
          buf.current = f.content;
        }
      }
      // Drop tabs/buffers whose file no longer exists on disk.
      for (const p of codeOpenTabs.slice()) {
        if (!files.some((f) => f.path === p)) {
          codeOpenTabs.splice(codeOpenTabs.indexOf(p), 1);
          codeBuffers.delete(p);
        }
      }

      const openFile = (p: string): void => {
        if (!codeBuffers.has(p)) {
          const f = files.find((x) => x.path === p);
          if (!f) return;
          codeBuffers.set(p, {
            original: f.content,
            current: f.content,
            language: languageHint(p),
          });
        }
        if (!codeOpenTabs.includes(p)) codeOpenTabs.push(p);
        codeActivePath = p;
      };

      if (!codeActivePath || !files.some((f) => f.path === codeActivePath)) {
        codeActivePath = files.find((f) => f.path === 'index.html')?.path ?? files[0]!.path;
      }
      openFile(codeActivePath);

      const dirtyPaths = (): string[] =>
        [...codeBuffers.entries()].filter(([, b]) => b.current !== b.original).map(([p]) => p);

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

      // Folders containing the active file start expanded so the user can
      // see where it lives. Search auto-expands matching paths too.
      const expanded = new Set<string>();
      {
        const parts = (codeActivePath ?? '').split('/');
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

      const drawTree = (): void => {
        treeWrap.innerHTML = '';

        const searchInput = el('input', {
          class: 'code-search-input',
          placeholder: 'Search code',
          value: search,
        }) as HTMLInputElement;
        searchInput.addEventListener('input', () => {
          search = searchInput.value.trim().toLowerCase();
          drawTree();
          // Keep the input focused after re-render.
          const next = treeWrap.querySelector('.code-search-input') as HTMLInputElement | null;
          if (next) {
            next.focus();
            next.setSelectionRange(search.length, search.length);
          }
        });
        treeWrap.append(
          el('div', { class: 'code-search' }, [
            el('span', {
              class: 'code-search-icon',
              trustedHtml: Icon.Search({ size: 13 }),
            }),
            searchInput,
            el('span', { class: 'code-search-kbd' }, '⌘P'),
          ]),
        );

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
          const buf = codeBuffers.get(node.path);
          const isDirty = !!buf && buf.current !== buf.original;
          const row = el(
            'button',
            {
              class: 'code-tree-row code-tree-file',
              'data-active': String(codeActivePath === node.path),
              'data-dirty': String(isDirty),
              'data-depth': String(depth),
              onClick: () => {
                openFile(node.path);
                drawTree();
                drawTabs();
                drawHead();
                drawEditorHost();
              },
            },
            [
              el('span', { class: 'code-tree-chevron-spacer' }),
              el('span', { class: 'code-tree-lang-dot', 'data-lang': lang }),
              el('span', { class: 'code-tree-name' }, node.name),
              ...(isDirty ? [el('span', { class: 'code-tree-dirty' })] : []),
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
        // that the gateway runs server-side: actions, queries,
        // migrations, automations). Sub-items inside each group keep
        // the existing recursive walk.
        const BACKEND_DIRS = new Set(['actions', 'queries', 'migrations', 'automations']);
        const backend = visible.filter((n) => n.kind === 'folder' && BACKEND_DIRS.has(n.name));
        const frontend = visible.filter((n) => !backend.includes(n));

        // When search is active we let the user see whatever matched —
        // section headers only appear when both groups are populated.
        const showHeaders = !search && frontend.length > 0 && backend.length > 0;

        // Group header with a trailing mono count (matches the cd-eyebrow
        // + count in RefinedBuilderCode's file tree).
        const groupHead = (label: string, count: number): HTMLElement =>
          el('div', { class: 'code-tree-group-head' }, [
            el('span', {}, label),
            el('span', { class: 'code-tree-group-count' }, String(count)),
          ]);

        if (showHeaders) {
          list.append(groupHead('Frontend', frontend.length));
        }
        walk(frontend, 0);

        if (backend.length > 0) {
          if (showHeaders) {
            list.append(groupHead('Backend', backend.length));
          }
          walk(backend, 0);
        }

        if (visible.length === 0) {
          list.append(el('div', { class: 'empty code-tree-empty' }, 'No matches'));
        }

        treeWrap.append(list);
      };

      // ---- Editable editor. One tab strip carries the open-file tabs
      // plus a trailing Diff / Save / ⋯ action cluster — the refined
      // artboard has no separate file-info head — then the editor
      // surface and the status strip. ----
      const tabStrip = el('div', { class: 'code-tab-strip' });
      const tabActions = el('div', { class: 'code-tab-actions' });
      const tabsBar = el('div', { class: 'code-tabs' }, [tabStrip, tabActions]);
      const editorHost = el('div', { class: 'code-editor-host' });
      const statusBar = el('div', { class: 'code-status' });
      workspace.append(tabsBar, editorHost, statusBar);

      // Bottom status strip — "N lines · KB · autosaving · line L col C ·
      // LANG" (matches RefinedBuilderCode). `caret` is refreshed live by
      // the editor's selection listener; the rest by file/dirty changes.
      let caretLine = 1;
      let caretCol = 1;
      function drawStatus(): void {
        statusBar.innerHTML = '';
        const p = codeActivePath;
        const buf = p ? codeBuffers.get(p) : undefined;
        if (!p || !buf) return;
        const lineCount = buf.current.split('\n').length;
        const bytes = new TextEncoder().encode(buf.current).byteLength;
        const nDirty = dirtyPaths().length;
        const lang = languageHint(p);
        const sep = (): HTMLElement => el('span', { class: 'code-status-sep' }, '·');
        statusBar.append(
          el(
            'span',
            {},
            `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} · ${formatBytes(bytes)}`,
          ),
          sep(),
          el('span', { class: 'code-status-save' }, [
            el('span', { class: 'code-status-dot' }),
            nDirty > 0
              ? `autosaving · ${nDirty} unsaved file${nDirty === 1 ? '' : 's'}`
              : 'all saved',
          ]),
          el('span', { class: 'code-status-spacer' }),
          el('span', {}, `line ${caretLine} · col ${caretCol}`),
          sep(),
          el('span', {}, LANG_DISPLAY[lang] ?? 'TXT'),
        );
      }

      const basename = (p: string): string =>
        p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;

      const saveFile = async (p: string): Promise<void> => {
        const buf = codeBuffers.get(p);
        if (!buf || buf.current === buf.original) return;
        try {
          await writeAppFile({ id: pid, path: p, content: buf.current });
          buf.original = buf.current;
          showToast(`Saved ${basename(p)}`);
        } catch (err) {
          showToast(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        drawTree();
        drawTabs();
        drawHead();
        drawStatus();
      };
      const saveAll = async (): Promise<void> => {
        for (const p of dirtyPaths()) await saveFile(p);
        // Saved files mean the preview is now stale — nudge it on next view.
      };
      const revertActive = (): void => {
        const buf = codeActivePath ? codeBuffers.get(codeActivePath) : undefined;
        if (!buf) return;
        buf.current = buf.original;
        drawTree();
        drawTabs();
        drawHead();
        drawEditorHost();
      };
      const closeTab = (p: string): void => {
        const idx = codeOpenTabs.indexOf(p);
        if (idx < 0) return;
        codeOpenTabs.splice(idx, 1);
        codeBuffers.delete(p);
        if (codeActivePath === p) {
          codeActivePath = codeOpenTabs[Math.max(0, idx - 1)];
          if (codeActivePath) openFile(codeActivePath);
        }
        drawTree();
        drawTabs();
        drawHead();
        drawEditorHost();
      };

      function drawTabs(): void {
        tabStrip.innerHTML = '';
        for (const p of codeOpenTabs) {
          const buf = codeBuffers.get(p);
          const dirty = !!buf && buf.current !== buf.original;
          const tab = el('div', {
            class: 'code-tab',
            'data-active': String(codeActivePath === p),
            'data-dirty': String(dirty),
          });
          tab.append(
            el('span', {
              class: 'code-tab-dot',
              'data-lang': languageHint(p),
            }),
            el(
              'button',
              {
                class: 'code-tab-label',
                title: p,
                onClick: () => {
                  openFile(p);
                  drawTree();
                  drawTabs();
                  drawHead();
                  drawEditorHost();
                },
              },
              basename(p),
            ),
            el('button', {
              'aria-label': `Close ${basename(p)}`,
              class: 'code-tab-close',
              trustedHtml: dirty ? '' : Icon.X({ size: 11, strokeWidth: 2.5 }),
              title: dirty ? 'Unsaved changes' : 'Close',
              onClick: () => closeTab(p),
            }),
          );
          tabStrip.append(tab);
        }
      }

      // Trailing action cluster in the tab strip — a Diff toggle, a
      // per-file Save, and a ⋯ overflow (Save all / Revert / Open
      // folder). Redrawn whenever the active file or dirty state changes.
      function drawHead(): void {
        tabActions.innerHTML = '';
        const p = codeActivePath;
        const buf = p ? codeBuffers.get(p) : undefined;
        if (!p || !buf) return;
        const dirty = buf.current !== buf.original;
        const nDirty = dirtyPaths().length;

        const diffBtn = el(
          'button',
          {
            class: 'btn btn-ghost tiny-btn',
            'data-active': String(codeDiffMode),
            disabled: dirty ? undefined : '',
            title: dirty ? 'Toggle diff against last save' : 'No changes to diff',
            onClick: () => {
              codeDiffMode = !codeDiffMode;
              drawHead();
              drawEditorHost();
            },
          },
          'Diff',
        );
        const saveBtn = el(
          'button',
          {
            class: 'btn btn-primary tiny-btn',
            disabled: dirty ? undefined : '',
            onClick: () => void saveFile(p),
          },
          'Save',
        );

        // Overflow — Save all / Revert / Open folder.
        const overflow = el('button', {
          'aria-label': 'More code actions',
          class: 'btn btn-ghost tiny-btn code-overflow-btn',
          trustedHtml:
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
        });
        const menu = el('div', { class: 'code-overflow-menu', hidden: '' });
        const menuItem = (label: string, onClick: () => void, disabled = false): HTMLElement =>
          el(
            'button',
            {
              class: 'code-overflow-item',
              disabled: disabled ? '' : undefined,
              onClick: () => {
                menu.setAttribute('hidden', '');
                onClick();
              },
            },
            label,
          );
        menu.append(
          menuItem(
            nDirty > 0 ? `Save all (${nDirty})` : 'Save all',
            () => void saveAll(),
            nDirty === 0,
          ),
          menuItem('Revert this file', revertActive, !dirty),
        );
        // "Open app folder" reveals the on-disk worktree, which only
        // the local gateway materializes (issue #141). Hide it for a
        // remote gateway — there's no local folder to open.
        if (window.Centraid?.getRuntimeMode() !== 'remote') {
          menu.append(menuItem('Open app folder', () => void Api().openAppFolder({ id: pid })));
        }
        overflow.addEventListener('click', (e) => {
          e.stopPropagation();
          const wasHidden = menu.hasAttribute('hidden');
          if (wasHidden) menu.removeAttribute('hidden');
          else menu.setAttribute('hidden', '');
        });
        document.addEventListener('click', () => menu.setAttribute('hidden', ''), {
          capture: true,
        });
        const overflowWrap = el('div', { class: 'code-overflow-wrap' }, [overflow, menu]);

        tabActions.append(diffBtn, saveBtn, overflowWrap);
      }

      function drawEditorHost(): void {
        editorHost.innerHTML = '';
        const p = codeActivePath;
        const buf = p ? codeBuffers.get(p) : undefined;
        if (!p || !buf) {
          editorHost.append(el('div', { class: 'empty' }, 'No file open.'));
          drawStatus();
          return;
        }
        if (codeDiffMode) {
          editorHost.append(buildDiffView(buf));
          drawStatus();
          return;
        }
        editorHost.append(buildEditor(p, buf));
        drawStatus();
      }

      const buildDiffView = (buf: CodeBuffer): HTMLElement => {
        const rows = lineDiff(buf.original, buf.current);
        const wrap = el('div', { class: 'code-diff' });
        for (const r of rows) {
          const sign = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
          wrap.append(
            el('div', { class: 'code-diff-row', 'data-type': r.type }, [
              el('span', { class: 'code-diff-num' }, r.aNum ? String(r.aNum) : ''),
              el('span', { class: 'code-diff-num' }, r.bNum ? String(r.bNum) : ''),
              el('span', { class: 'code-diff-sign' }, sign),
              el('span', { class: 'code-diff-text' }, r.text || ' '),
            ]),
          );
        }
        return wrap;
      };

      const buildEditor = (p: string, buf: CodeBuffer): HTMLElement => {
        const lang = languageHint(p);
        const editor = el('div', { class: 'code-editor' });
        const gutterInner = el('div', { class: 'code-edit-gutter-inner' });
        const gutter = el('div', { class: 'code-edit-gutter' }, [gutterInner]);
        const pre = el('pre', { class: 'code-edit-pre' });
        const preClip = el('div', { class: 'code-edit-pre-clip' }, [pre]);
        const ta = el('textarea', {
          class: 'code-edit-ta',
          spellcheck: 'false',
          wrap: 'off',
        }) as HTMLTextAreaElement;
        ta.value = buf.current;
        const surface = el('div', { class: 'code-edit-surface' }, [preClip, ta]);
        editor.append(gutter, surface);

        const paintGutter = (): void => {
          const n = buf.current.split('\n').length;
          const have = gutterInner.childElementCount;
          if (n === have) return;
          gutterInner.innerHTML = '';
          for (let i = 1; i <= n; i++) gutterInner.append(el('div', {}, String(i)));
        };
        const paintHighlight = (): void => {
          pre.innerHTML = tokenize(buf.current, lang) + '\n';
        };
        paintGutter();
        paintHighlight();

        // Caret position drives the bottom status strip's "line L col C".
        const refreshCaret = (): void => {
          const upto = ta.value.slice(0, ta.selectionStart);
          const nl = upto.lastIndexOf('\n');
          caretLine = upto.split('\n').length;
          caretCol = ta.selectionStart - (nl + 1) + 1;
          drawStatus();
        };
        ta.addEventListener('keyup', refreshCaret);
        ta.addEventListener('click', refreshCaret);
        ta.addEventListener('focus', refreshCaret);

        ta.addEventListener('input', () => {
          buf.current = ta.value;
          paintHighlight();
          paintGutter();
          // Dirty state changed — refresh the tab dots, tree, head, and
          // status without rebuilding the editor (keeps the caret/focus).
          drawTabs();
          drawHead();
          drawTree();
          refreshCaret();
        });
        ta.addEventListener('scroll', () => {
          pre.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
          gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
        });
        // Tab inserts two spaces rather than moving focus out of the editor.
        ta.addEventListener('keydown', (e) => {
          const ke = e as KeyboardEvent;
          if (ke.key === 'Tab') {
            ke.preventDefault();
            const s = ta.selectionStart;
            const eEnd = ta.selectionEnd;
            ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(eEnd);
            ta.selectionStart = s + 2;
            ta.selectionEnd = s + 2;
            ta.dispatchEvent(new Event('input'));
          } else if ((ke.metaKey || ke.ctrlKey) && ke.key.toLowerCase() === 's') {
            ke.preventDefault();
            void saveFile(p);
          }
        });
        return editor;
      };

      drawTree();
      drawTabs();
      drawHead();
      drawEditorHost();
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
        | 'automations'
        | 'users'
        | 'storage'
        | 'secrets'
        | 'functions'
        | 'sql'
        | 'logs';
      const sections: [CloudSection, string, (n?: number) => string, boolean][] = [
        ['overview', 'Overview', CloudOverviewIcon, true],
        ['database', 'Database', DatabaseIcon, true],
        ['automations', 'Automations', AutomationsIcon, true],
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

      // Automations state (issue #70). Read from the per-gateway mirror
      // table; rebuilds entirely on each refresh + after every UI mutation
      // (toggle, delete, run-now) so the panel always reflects what the
      // host scheduler is about to fire.
      let automationsCache: CentraidAutomationRow[] | undefined | 'pending' | 'error';
      let automationsError: string | undefined;
      // Per-row run state so the spinner + last-result chip survive a
      // re-render. Keyed by automation name.
      const automationRunState = new Map<
        string,
        | { kind: 'idle' }
        | { kind: 'running' }
        | { kind: 'done'; ok: boolean; durationMs: number; error?: string; finishedAt: number }
      >();
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
        if (!appId) {
          schemaCache = undefined;
          return;
        }
        if (!force && schemaCache !== undefined && schemaCache !== 'error') return;
        schemaCache = 'pending';
        schemaError = undefined;
        try {
          schemaCache = await appSchema({ id: appId });
        } catch (err) {
          schemaCache = 'error';
          schemaError = err instanceof Error ? err.message : String(err);
        }
        if (active === 'database' || active === 'overview') drawStage();
      }

      async function ensureVersions(force = false): Promise<void> {
        if (!appId) {
          versionsCache = undefined;
          return;
        }
        if (!force && versionsCache !== undefined && versionsCache !== 'error') return;
        versionsCache = 'pending';
        try {
          versionsCache = await listVersions({ id: appId });
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
                  : active === 'automations'
                    ? 'Cron-scheduled actions registered for this app. Toggle, run now, or remove them.'
                    : 'View and manage the data stored in your app.';

        // The Overview surface opens straight into its hero strip — the
        // refined artboard has no "Overview" page heading — so the stage
        // head is rendered for every section except Overview.
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
        } else if (active === 'automations') {
          const refreshBtn = el('button', {
            'aria-label': 'Refresh automations',
            class: 'btn btn-ghost cloud-refresh-btn',
            title: 'Refresh automations',
            onClick: () => void refreshAutomations(),
          });
          refreshBtn.innerHTML = `${RefreshIcon(13)}<span>Refresh</span>`;
          head.append(refreshBtn);
        }
        if (active !== 'overview') stage.append(head);

        if (active === 'overview') {
          drawOverview();
        } else if (active === 'database') {
          drawDatabase();
        } else if (active === 'sql') {
          drawSqlEditor();
        } else if (active === 'logs') {
          drawLogs();
        } else if (active === 'automations') {
          drawAutomations();
        } else {
          const empty = el('div', { class: 'cloud-empty' });
          empty.textContent =
            'Not yet available. The backend for this section will land in a future release.';
          stage.append(empty);
        }
      };

      function drawOverview(): void {
        if (!appId) {
          const empty = el('div', { class: 'cloud-empty' });
          empty.textContent = 'No app yet.';
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

        // Active version — drives both the hero eyebrow ("LIVE · V1 ·
        // PUBLISHED 3H AGO") and the Versions stat tile's date sub-line.
        const versionList =
          versionsCache && versionsCache !== 'pending' && versionsCache !== 'error'
            ? versionsCache.versions
            : [];
        const activeVersionId =
          versionsCache && versionsCache !== 'pending' && versionsCache !== 'error'
            ? versionsCache.activeVersion
            : undefined;
        const activeVersion =
          versionList.find((v) => v.current || v.versionId === activeVersionId) ?? versionList[0];

        // ---- Hero strip — the live deployment URL is the headline fact
        // of the Cloud surface. An icon tile + status eyebrow + mono URL
        // on the left; Open / Copy / Share actions on the trailing edge.
        const hero = el('div', { class: 'cloud-hero', 'data-live': String(!!liveUrl) });
        const heroTile = el('div', {
          class: 'cloud-hero-tile',
          'data-status': liveUrl ? 'live' : 'off',
          trustedHtml: Icon.Eye({ size: 21 }),
        });
        if (liveUrl) {
          const url = liveUrl;
          const verLabel = activeVersion?.declaredVersion
            ? ` · V${activeVersion.declaredVersion}`
            : '';
          const whenLabel = activeVersion
            ? ` · PUBLISHED ${relativeWhen(activeVersion.uploadedAt).toUpperCase()}`
            : '';
          const copyUrl = (msg: string): void => {
            void navigator.clipboard
              .writeText(url)
              .then(() => showToast(msg))
              .catch(() => showToast('Copy failed'));
          };
          const heroBtn = (glyph: string, label: string, onClick: () => void): HTMLElement =>
            el('button', {
              class: 'cloud-hero-btn',
              type: 'button',
              trustedHtml: `${glyph}<span>${label}</span>`,
              onClick,
            });
          hero.append(
            heroTile,
            el('div', { class: 'cloud-hero-meta' }, [
              el('div', { class: 'cloud-hero-eyebrow' }, [
                el('span', { class: 'cloud-hero-dot', 'data-status': 'live' }),
                el('span', {}, `LIVE${verLabel}${whenLabel}`),
              ]),
              el('span', { class: 'cloud-hero-url' }, formatPreviewUrl(url)),
            ]),
            el('div', { class: 'cloud-hero-actions' }, [
              heroBtn(Icon.Eye({ size: 13 }), 'Open', () => {
                window.open(url, '_blank');
              }),
              heroBtn(Icon.Copy({ size: 13 }), 'Copy', () => copyUrl('Copied URL')),
              heroBtn(Icon.Share({ size: 13 }), 'Share', () => copyUrl('Share link copied')),
            ]),
          );
        } else {
          hero.append(
            heroTile,
            el('div', { class: 'cloud-hero-meta' }, [
              el('div', { class: 'cloud-hero-eyebrow' }, [
                el('span', { class: 'cloud-hero-dot', 'data-status': 'off' }),
                el('span', {}, 'NOT DEPLOYED'),
              ]),
              el(
                'span',
                { class: 'cloud-hero-url cloud-hero-url--muted' },
                'Publish to get a live URL',
              ),
            ]),
          );
        }
        stage.append(hero);

        // ---- Status — four stat tiles (Schema · Tables · Versions ·
        // Gateway) under a caps section label. ----
        stage.append(el('div', { class: 'cloud-section-label' }, 'Status'));
        const grid = el('div', { class: 'cloud-stat-grid' });
        const statCard = (label: string, body: string): HTMLElement => {
          const card = el('div', { class: 'cloud-stat-card' });
          card.innerHTML = `<div class="cloud-stat-eyebrow"><span>${escapeHtml(label)}</span></div>${body}`;
          return card;
        };

        // Schema version.
        let schemaBody: string;
        if (schemaCache === 'pending' || schemaCache === undefined) {
          schemaBody = '<div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (schemaCache === 'error') {
          schemaBody = `<div class="cloud-stat-value cloud-stat-muted">Unavailable</div><div class="cloud-stat-sub">${escapeHtml(schemaError ?? 'gateway error')}</div>`;
        } else if (!schemaCache) {
          schemaBody =
            '<div class="cloud-stat-value cloud-stat-muted">—</div><div class="cloud-stat-sub">Publish to create the database</div>';
        } else {
          schemaBody = `<div class="cloud-stat-value">v${schemaCache.schemaVersion}</div><div class="cloud-stat-sub">${schemaCache.schemaVersion === 1 ? 'Never migrated' : 'Up to date'}</div>`;
        }
        grid.append(statCard('Schema', schemaBody));

        // Tables.
        let tableBody: string;
        if (schemaCache === 'pending' || schemaCache === undefined) {
          tableBody = '<div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (!schemaCache || schemaCache === 'error') {
          tableBody = '<div class="cloud-stat-value cloud-stat-muted">—</div>';
        } else {
          const s = schemaCache;
          tableBody = `<div class="cloud-stat-value">${s.tables.length}</div><div class="cloud-stat-sub">${s.indexes.length} index${s.indexes.length === 1 ? '' : 'es'} · ${s.views.length} view${s.views.length === 1 ? '' : 's'}</div>`;
        }
        grid.append(statCard('Tables', tableBody));

        // Versions.
        let versionBody: string;
        if (versionsCache === 'pending' || versionsCache === undefined) {
          versionBody = '<div class="cloud-stat-value cloud-stat-muted">Loading…</div>';
        } else if (versionsCache === 'error') {
          versionBody = '<div class="cloud-stat-value cloud-stat-muted">—</div>';
        } else {
          const sub = activeVersion
            ? `active · ${activeVersion.uploadedAt.slice(0, 10)}`
            : 'No active version';
          versionBody = `<div class="cloud-stat-value">${versionsCache.versions.length}</div><div class="cloud-stat-sub">${escapeHtml(sub)}</div>`;
        }
        grid.append(statCard('Versions', versionBody));

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
        const gatewayCard = el('div', { class: 'cloud-stat-card' });
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

        // ---- Recent activity — the version history reads as a
        // chronological deploy log: newest publish first, each row an
        // icon tile + title (+ Active flag) + a mono "Builder · when". ----
        stage.append(el('div', { class: 'cloud-section-label' }, 'Recent activity'));
        const feed = el('div', { class: 'cloud-feed' });
        if (versionsCache === 'pending' || versionsCache === undefined) {
          feed.append(el('div', { class: 'cloud-feed-empty' }, 'Loading activity…'));
        } else if (versionsCache === 'error' || versionsCache.versions.length === 0) {
          feed.append(
            el(
              'div',
              { class: 'cloud-feed-empty' },
              'No activity yet — publish your app to deploy it.',
            ),
          );
        } else {
          const ordered = [...versionsCache.versions].sort((a, b) =>
            b.uploadedAt.localeCompare(a.uploadedAt),
          );
          for (const v of ordered) {
            const isActive = v.current || v.versionId === versionsCache.activeVersion;
            const row = el('div', { class: 'cloud-feed-row' }, [
              el('div', {
                class: 'cloud-feed-tile',
                trustedHtml: Icon.Save({ size: 14 }),
              }),
              el('div', { class: 'cloud-feed-title-row' }, [
                el(
                  'span',
                  { class: 'cloud-feed-title' },
                  v.declaredVersion ? `Published v${v.declaredVersion}` : 'Published',
                ),
                ...(isActive ? [el('span', { class: 'cloud-feed-live' }, 'Active')] : []),
              ]),
              el('span', { class: 'cloud-feed-when' }, `Builder · ${relativeWhen(v.uploadedAt)}`),
            ]);
            feed.append(row);
          }
        }
        stage.append(feed);
      }

      function drawDatabase(): void {
        if (!appId) {
          const empty = el('div', { class: 'cloud-empty' });
          empty.textContent = 'No app yet.';
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
          if (!appId) return;
          rowsCache.set(tableName, { kind: 'pending' });
          paint();
          try {
            const r = await appTableRows({
              id: appId,
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
        if (!appId) {
          stage.append(el('div', { class: 'cloud-empty' }, 'No app yet.'));
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
            const r = await appQuery({ id: appId!, sql });
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
        if (!appId) {
          stage.append(el('div', { class: 'cloud-empty' }, 'No app yet.'));
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
        if (!appId) return;
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
          const r = await appLogs({ id: appId, limit: 200 });
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

      function drawAutomations(): void {
        if (!appId) {
          stage.append(el('div', { class: 'cloud-empty' }, 'No app yet.'));
          return;
        }

        const wrap = el('div', { class: 'cloud-automations' });

        if (automationsCache === undefined || automationsCache === 'pending') {
          wrap.append(
            el('div', { class: 'cloud-empty cloud-empty-quiet' }, 'Loading automations…'),
          );
          stage.append(wrap);
          if (automationsCache === undefined) void refreshAutomations();
          return;
        }

        if (automationsCache === 'error') {
          const e = el('div', { class: 'cloud-empty' });
          e.innerHTML = `Could not load automations.<br><span class="cloud-stat-sub">${escapeHtml(automationsError ?? 'unknown error')}</span>`;
          wrap.append(e);
          stage.append(wrap);
          return;
        }

        if (automationsCache.length === 0) {
          const e = el('div', { class: 'cloud-empty' });
          e.innerHTML = `No automations yet.<br><span class="cloud-stat-sub">Ask the builder to "set up an automation that runs every…" or drop a manifest into the app's <code>automations/</code> folder, then republish to deploy.</span>`;
          wrap.append(e);
          stage.append(wrap);
          return;
        }

        for (const row of automationsCache) {
          wrap.append(renderAutomationRow(row));
        }

        stage.append(wrap);
      }

      function renderAutomationRow(row: CentraidAutomationRow): HTMLElement {
        const runState = automationRunState.get(row.name) ?? { kind: 'idle' };
        const card = el('div', {
          class: 'cloud-automation-row',
          'data-enabled': String(row.enabled),
        });

        // Header line: name + cron expression + enabled toggle.
        const head = el('div', { class: 'cloud-automation-head' });
        const titleWrap = el('div', { class: 'cloud-automation-title' });
        titleWrap.append(el('span', { class: 'cloud-automation-name' }, row.name));
        titleWrap.append(
          el(
            'span',
            { class: 'cloud-automation-cron', title: 'Triggers' },
            row.triggers.map((t) => (t.kind === 'cron' ? t.expr : 'webhook')).join(' · ') ||
              'manual',
          ),
        );
        head.append(titleWrap);

        const toggleLabel = el('label', { class: 'cloud-automation-toggle' });
        const toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
        toggle.checked = row.enabled;
        toggle.addEventListener('change', () => {
          void onToggleAutomation(row, toggle);
        });
        toggleLabel.append(toggle);
        toggleLabel.append(
          el('span', { class: 'cloud-automation-toggle-text' }, row.enabled ? 'On' : 'Off'),
        );
        head.append(toggleLabel);
        card.append(head);

        // Prompt body (the user's NL prompt verbatim).
        const promptEl = el('div', { class: 'cloud-automation-prompt' });
        promptEl.textContent = row.manifest.prompt;
        card.append(promptEl);

        // Metadata strip: automation id · generated-by · model.
        const meta = el('div', { class: 'cloud-automation-meta' });
        meta.append(
          el('span', { class: 'cloud-automation-meta-item', title: 'Automation app id' }, row.id),
        );
        if (row.manifest.requires.model) {
          meta.append(
            el(
              'span',
              { class: 'cloud-automation-meta-item', title: 'Model used by ctx.agent calls' },
              row.manifest.requires.model,
            ),
          );
        }
        meta.append(
          el(
            'span',
            { class: 'cloud-automation-meta-item cloud-automation-meta-faint' },
            `by ${row.manifest.generated.by}`,
          ),
        );
        card.append(meta);

        // Action row: Run now · Delete · per-row run-result chip.
        const actions = el('div', { class: 'cloud-automation-actions' });
        const runBtn = el('button', {
          class: 'btn btn-ghost cloud-automation-run',
          disabled: runState.kind === 'running',
          onClick: () => void onRunAutomation(row),
        }) as HTMLButtonElement;
        runBtn.textContent = runState.kind === 'running' ? 'Running…' : 'Run now';
        actions.append(runBtn);

        const delBtn = el('button', {
          class: 'btn btn-ghost cloud-automation-delete',
          onClick: () => void onDeleteAutomation(row),
        });
        delBtn.textContent = 'Delete';
        actions.append(delBtn);

        if (runState.kind === 'done') {
          const chip = el('span', {
            class: 'cloud-automation-result',
            'data-ok': String(runState.ok),
          });
          const ms = runState.durationMs;
          chip.textContent = runState.ok
            ? `OK in ${ms}ms`
            : `FAILED in ${ms}ms — ${runState.error ?? 'unknown error'}`;
          actions.append(chip);
        }
        card.append(actions);

        return card;
      }

      async function refreshAutomations(): Promise<void> {
        if (!appId) return;
        if (automationsCache === 'pending') return;
        const prior = automationsCache;
        automationsCache = 'pending';
        if (prior === undefined && active === 'automations') drawStage();
        try {
          // Automations are user-owned apps; this panel shows the
          // ones associated with the app being built (issue #91).
          const pid = appId;
          const all = await listAutomations();
          automationsCache = all.filter((r) => r.manifest.apps?.includes(pid));
          automationsError = undefined;
        } catch (err) {
          automationsCache = 'error';
          automationsError = err instanceof Error ? err.message : String(err);
        }
        if (active === 'automations') drawStage();
      }

      async function onToggleAutomation(
        row: CentraidAutomationRow,
        checkbox: HTMLInputElement,
      ): Promise<void> {
        if (!appId) return;
        const next = checkbox.checked;
        try {
          await setAutomationEnabled({ automationId: row.ref, enabled: next });
          await refreshAutomations();
        } catch (err) {
          // Revert the toggle so the UI doesn't misrepresent persisted state.
          checkbox.checked = row.enabled;
          automationsError = err instanceof Error ? err.message : String(err);
          automationsCache = 'error';
          if (active === 'automations') drawStage();
        }
      }

      async function onRunAutomation(row: CentraidAutomationRow): Promise<void> {
        if (!appId) return;
        automationRunState.set(row.name, { kind: 'running' });
        if (active === 'automations') drawStage();
        try {
          // run-now fires in the background and returns the run id; poll
          // the ledger for the finished record to report the outcome.
          const { runId } = await runAutomationNow({ automationId: row.ref });
          const rec = await waitForAutomationRun(runId);
          automationRunState.set(row.name, {
            kind: 'done',
            ok: rec.ok,
            durationMs: (rec.endedAt ?? Date.now()) - rec.startedAt,
            ...(rec.error ? { error: rec.error } : {}),
            finishedAt: Date.now(),
          });
        } catch (err) {
          automationRunState.set(row.name, {
            kind: 'done',
            ok: false,
            durationMs: 0,
            error: err instanceof Error ? err.message : String(err),
            finishedAt: Date.now(),
          });
        }
        if (active === 'automations') drawStage();
      }

      // Poll the run ledger until a run finishes — run-now fires in the
      // background, so a caller reporting an outcome must wait for it.
      async function waitForAutomationRun(runId: string): Promise<CentraidAutomationRunRecord> {
        const deadline = Date.now() + 6 * 60 * 1000;
        while (Date.now() < deadline) {
          const rec = await readAutomationRun({ runId });
          if (rec && rec.endedAt !== undefined) return rec;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        throw new Error('run did not finish within 6 minutes');
      }

      async function onDeleteAutomation(row: CentraidAutomationRow): Promise<void> {
        if (!appId) return;
        const ok = confirm(
          `Delete automation "${row.name}"?\n\nThis permanently removes the automation app directory and its run history.`,
        );
        if (!ok) return;
        try {
          await deleteAutomation({ automationId: row.ref });
          automationRunState.delete(row.name);
          await refreshAutomations();
        } catch (err) {
          automationsError = err instanceof Error ? err.message : String(err);
          automationsCache = 'error';
          if (active === 'automations') drawStage();
        }
      }

      drawRail();
      drawStage();
    }

    // Renders the version list into the supplied container. Used by the
    // chat-pane History view (chatView === 'history'); kept generic so a
    // future right-pane history view could reuse it.
    async function renderHistoryInto(list: HTMLElement): Promise<void> {
      if (!appId) {
        list.innerHTML = '<div class="empty">No app yet.</div>';
        return;
      }

      let result: Awaited<ReturnType<typeof listVersions>>;
      try {
        result = await listVersions({ id: appId });
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
                            await activateVersion({
                              id: appId!,
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
    // Resolve the gateway chat session this builder streams turns to. The
    // turn runs server-side in the app's `desktop-<id>` draft worktree (the
    // same worktree the Code tab edits), so the agent's file edits stage in
    // the draft and the preview reflects it; Publish is the explicit flip.
    //
    // 'continue' reuses the app's most recent session so the gateway
    // resumes the same adapter thread across builder reopens; 'fresh' always
    // mints a new session (first build — don't append onto a stale thread).
    async function ensureConversation(
      id: string,
      sessionMode: 'fresh' | 'continue',
    ): Promise<string> {
      if (conversationId) return conversationId;
      if (sessionMode === 'continue') {
        const sessions = await listConversations(id).catch(() => []);
        if (sessions[0]) {
          conversationId = sessions[0].id;
          return conversationId;
        }
      }
      conversationId = (await createConversation(id, projName)).id;
      return conversationId;
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

    // Settle a finished turn: close streaming bubbles + refresh the code/
    // preview tab (the agent may have staged file writes in the draft).
    function finishAgentTurn(): void {
      generating = false;
      closeAi();
      closeThinking();
      renderChat();
      if (isAutomation) {
        // The agent rewrote `automation.json` / `handler.js` — pull the
        // fresh manifest so the config pane reflects what it wrote.
        if (previewReloadPending) void refreshAutomationRow();
      } else {
        // Refresh code/preview tab if visible — agent may have written files.
        if (tab === 'code') renderRight();
        if (tab === 'preview' && previewReloadPending) renderRight();
      }
      previewReloadPending = false;
    }

    // Consume the gateway's native `TurnStreamEvent` union (issue #141,
    // Phase 3 — no IPC translation). The builder + the app-view data chat
    // now share this event model + the `streamTurn` transport — one chat
    // surface, both jobs. Tool calls carry a real `toolCallId`, so results
    // target their group directly.
    function handleStreamEvent(event: TurnStreamEvent): void {
      switch (event.type) {
        case 'assistant.start':
          generating = true;
          // Bubble created lazily on the first delta — a turn may emit only
          // reasoning + tool calls, which would leave a stale "…" placeholder.
          renderChat();
          return;
        case 'assistant.delta':
          closeThinking();
          if (currentAiMsgIndex < 0) {
            currentAiMsgIndex = pushMessage({ kind: 'ai', text: event.delta, streaming: true });
          } else {
            const cur = chat[currentAiMsgIndex];
            if (cur && cur.kind === 'ai') {
              updateMessage(currentAiMsgIndex, { text: cur.text + event.delta, streaming: true });
            }
          }
          return;
        case 'reasoning.delta':
          if (currentThinkingMsgIndex < 0) {
            currentThinkingMsgIndex = pushMessage({
              kind: 'thinking',
              text: event.delta,
              streaming: true,
            });
          } else {
            const cur = chat[currentThinkingMsgIndex];
            if (cur && cur.kind === 'thinking') {
              updateMessage(currentThinkingMsgIndex, {
                text: cur.text + event.delta,
                streaming: true,
              });
            }
          }
          return;
        case 'tool.start': {
          // A tool call is the agent acting — close any in-flight reasoning
          // and AI text so the next text starts a fresh bubble.
          closeThinking();
          closeAi();
          const newCall: ToolCall = {
            id: event.toolCallId,
            tool: event.toolName,
            summary: summarizeToolArgs(event.toolName, event.args),
            state: 'running',
          };
          const lastIdx = chat.length - 1;
          const last = chat[lastIdx];
          // Consolidate adjacent tool calls into one bubble; AI text/thinking
          // between calls breaks the group.
          if (last && last.kind === 'toolGroup') {
            const updated: ConversationMsg = { ...last, calls: [...last.calls, newCall] };
            chat = chat.map((m, i) => (i === lastIdx ? updated : m));
            renderChat();
            pendingToolStarts.set(event.toolCallId, lastIdx);
          } else {
            const idx = pushMessage({
              kind: 'toolGroup',
              id: event.toolCallId,
              calls: [newCall],
              open: true,
            });
            pendingToolStarts.set(event.toolCallId, idx);
          }
          return;
        }
        case 'tool.result': {
          const groupIdx = pendingToolStarts.get(event.toolCallId);
          pendingToolStarts.delete(event.toolCallId);
          if (groupIdx !== undefined) {
            const grp = chat[groupIdx];
            if (grp && grp.kind === 'toolGroup') {
              const calls = grp.calls.map((c) =>
                c.id === event.toolCallId
                  ? { ...c, state: event.ok ? ('ok' as const) : ('error' as const) }
                  : c,
              );
              chat = chat.map((m, i) => (i === groupIdx ? { ...grp, calls } : m));
              renderChat();
            }
          }
          if (event.ok && FILE_WRITING_TOOLS.has(event.toolName)) {
            previewReloadPending = true;
            // A successful file write counts as an edit — bump the header
            // relative-time so 'edited 14h ago' rolls to 'just now'.
            appLastEditedAt = Date.now();
          }
          return;
        }
        case 'webhooks':
          announceMintedWebhooks(event.minted);
          return;
        case 'final':
        case 'aborted':
          finishAgentTurn();
          return;
        case 'error':
          generating = false;
          closeAi();
          closeThinking();
          pushMessage({ kind: 'status', text: `Agent error: ${event.message}` });
          renderChat();
          return;
        case 'phase':
        case 'usage':
          break;
      }
    }

    // A webhook trigger the agent declared this turn cannot be minted
    // by the agent — the builder provisions it server-side and returns
    // the one-time secret here. Surface it as an assistant message so
    // it stays copyable; it is never persisted (the manifest keeps only
    // the hash) and won't survive a reload, which is the intent.
    function announceMintedWebhooks(minted: CentraidMintedWebhook[]): void {
      for (const w of minted) {
        pushMessage({
          kind: 'ai',
          text:
            `Webhook provisioned for “${w.automationId}”.\n\n` +
            `Endpoint (POST): ${w.url}\n` +
            `Secret (shown once — save it now): ${w.secret}\n\n` +
            'Authenticate each request with the header ' +
            '`Authorization: Bearer <secret>`. The secret is not stored — ' +
            'only a hash is kept in automation.json.',
        });
      }
      if (minted.length > 0) renderChat();
    }

    async function sendUserPrompt(text: string): Promise<void> {
      if (!appId) return;
      pushMessage({ kind: 'user', text });
      generating = true;
      currentAiMsgIndex = -1;
      currentThinkingMsgIndex = -1;
      renderChat();
      try {
        const sessionId = await ensureConversation(appId, 'continue');
        agentAbort = new AbortController();
        await streamTurn(
          appId,
          { conversationId: sessionId, message: text },
          handleStreamEvent,
          agentAbort.signal,
        );
        // Stream ended; settle in case it closed without a terminal event.
        if (generating) finishAgentTurn();
      } catch (err) {
        if (agentAbort?.signal.aborted) {
          finishAgentTurn();
          return;
        }
        generating = false;
        pushMessage({ kind: 'status', text: `Agent error: ${String(err)}` });
        renderChat();
      }
    }

    async function bootstrap(): Promise<void> {
      if (isAutomation && appId) {
        // The automation app is scaffolded as a draft before the
        // builder opens, so this is always a "reopen" — load the manifest
        // snapshot, then seed the intro. The gateway resumes the prior
        // adapter thread via the reused chat session (ensureConversation).
        chat = [];
        renderChat();
        await refreshAutomationRow();
        chat = chat.concat([
          {
            kind: 'ai',
            text:
              'Let’s build your automation. Describe what it should do and ' +
              'when it should run — for example, “every weekday morning, ' +
              'summarize yesterday’s new GitHub issues.”',
          },
        ]);
        renderChat();
        if (initialPrompt) await sendUserPrompt(initialPrompt);
        return;
      }

      if (isUpdateMode && appId) {
        // No "Editing existing app" divider — the app context lives
        // in the header now (icon + name + version + sync state). Real chat
        // history loads below; nothing to seed.
        chat = [];
        renderChat();
        // Probe whether this app is actually published on the gateway.
        // `appLiveUrl` only builds a URL string — it never fails — so it
        // can't tell us whether the gateway has the app or is even running.
        // `listVersions` actually contacts the gateway and 404s when the app
        // isn't there, so it's the honest probe.
        try {
          const versions = await listVersions({ id: appId });
          if (versions.activeVersion) {
            const r = await appLiveUrl({ id: appId });
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
        // Seed a fresh pane. The gateway resumes the app's prior adapter
        // thread on the first turn via the reused chat session
        // (ensureConversation → most recent session), so the agent keeps
        // context even though the pane starts empty across reopens.
        chat = chat.concat([
          {
            kind: 'ai',
            text: `Loaded "${projName}". Pick a direction below or describe the next change.`,
          },
        ]);
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

      // Fresh build: scaffold + open a fresh chat session + send first prompt.
      const id = generateAppId(initialPrompt);
      // Date divider carries the conversation start time (refined proposal
      // RBChat — "Today · 14:22").
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(
        2,
        '0',
      )}`;
      pushMessage({ kind: 'divider', text: `Today · ${hhmm}` });
      pushMessage({ kind: 'status', text: 'Setting up app…', spinning: true });
      try {
        await createApp({ id, name: projName, version: '0.1.0' });
        appId = id;
        // Subtitle holds the editable description, not a status — leave it
        // alone so the user's placeholder/value isn't clobbered.
      } catch (err) {
        pushMessage({ kind: 'status', text: `Could not create app: ${String(err)}` });
        return;
      }

      try {
        // First build → a FRESH chat session so the initial prompt isn't
        // appended onto a stale thread from a prior app at the same id.
        conversationId = (await createConversation(id, projName)).id;
      } catch (err) {
        pushMessage({ kind: 'status', text: `Could not start chat: ${String(err)}` });
        return;
      }

      await sendUserPrompt(initialPrompt);
    }

    // ---------- Automation builder ----------
    // The primary button is the draft commit gate: a draft automation
    // shows "Enable" (turns the schedule on); an enabled one shows
    // "Disable". The agent never flips `enabled` itself — that decision
    // is the user's, made here.
    function paintAutomationPrimary(): void {
      const enabled = automationRow?.enabled === true;
      primaryBtn.innerHTML =
        (enabled ? Icon.Pause({ size: 11 }) : Icon.Play({ size: 11 })) +
        `<span>${enabled ? 'Disable' : 'Enable'}</span>`;
      primaryBtn.dataset.kind = enabled ? 'disable' : 'enable';
    }

    // Re-read `automation.json` and repaint the header + config pane.
    // Called on bootstrap and after every agent turn that touched files.
    async function refreshAutomationRow(): Promise<void> {
      if (!appId) return;
      try {
        // The builder opens an automation app by its folder id; resolve
        // the single automation it owns to get the `<appId>/<id>` handle.
        const all = await listAutomations();
        const row = all.find((r) => r.ownerApp === appId);
        if (row) automationRow = row;
      } catch {
        /* keep the last good snapshot */
      }
      if (automationRow) {
        projName = automationRow.manifest.name || automationRow.id;
        projNameEl.textContent = projName;
      }
      paintAutomationPrimary();
      refreshSyncStatus();
      if (isAutomation && (tab === 'config' || tab === 'runs')) renderRight();
    }

    async function handleToggleEnabled(): Promise<void> {
      if (!appId || automationBusy || !automationRow) return;
      const ref = automationRow.ref;
      const next = !(automationRow.enabled === true);
      automationBusy = true;
      primaryBtn.setAttribute('disabled', '');
      refreshSyncStatus();
      try {
        await setAutomationEnabled({ automationId: ref, enabled: next });
        showToast(next ? 'Automation enabled — schedule is live' : 'Automation disabled');
        await refreshAutomationRow();
      } catch (err) {
        showToast(`Could not ${next ? 'enable' : 'disable'}: ${String(err)}`);
      } finally {
        automationBusy = false;
        primaryBtn.removeAttribute('disabled');
        refreshSyncStatus();
      }
    }

    // Test fire — run the handler once now, surfacing the outcome in chat.
    async function runAutomationOnce(): Promise<void> {
      if (!appId || automationBusy || !automationRow) return;
      const ref = automationRow.ref;
      automationBusy = true;
      refreshSyncStatus();
      if (tab === 'runs') renderRight();
      const statusIdx = pushMessage({
        kind: 'status',
        text: 'Running automation…',
        spinning: true,
      });
      try {
        // run-now fires in the background and returns the run id; poll
        // the ledger for the finished record to surface the outcome.
        const { runId } = await runAutomationNow({ automationId: ref });
        const deadline = Date.now() + 6 * 60 * 1000;
        let rec: CentraidAutomationRunRecord | null = null;
        while (Date.now() < deadline) {
          rec = await readAutomationRun({ runId });
          if (rec && rec.endedAt !== undefined) break;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (!rec || rec.endedAt === undefined) {
          throw new Error('run did not finish within 6 minutes');
        }
        const durationMs = rec.endedAt - rec.startedAt;
        updateMessage(statusIdx, {
          kind: 'status',
          spinning: false,
          text: rec.ok
            ? `Test run finished in ${(durationMs / 1000).toFixed(1)}s`
            : `Test run failed: ${rec.error ?? 'unknown error'}`,
        });
        showToast(rec.ok ? 'Test run finished' : 'Test run failed');
      } catch (err) {
        updateMessage(statusIdx, {
          kind: 'status',
          spinning: false,
          text: `Test run error: ${String(err)}`,
        });
      } finally {
        automationBusy = false;
        refreshSyncStatus();
        if (tab === 'runs') renderRight();
      }
    }

    function fmtRetention(keep: CentraidAutomationManifest['history']['keep']): string {
      if (keep === 'all') return 'Keep all runs';
      if (keep === 'errors') return 'Keep failed runs only';
      if (typeof keep === 'object' && 'count' in keep) return `Last ${keep.count} runs`;
      if (typeof keep === 'object' && 'days' in keep) return `Last ${keep.days} days`;
      return '—';
    }

    function cfgRow(label: string, value: string): HTMLElement {
      return el('div', { class: 'ab-row' }, [
        el('span', { class: 'ab-row-label' }, label),
        el('span', { class: 'ab-row-value' }, value),
      ]);
    }

    // Read-only config pane — a rendered view of `automation.json`. Every
    // field here is filled by the chat agent; the user changes them by
    // describing the change in the conversation, not by editing the form.
    function renderConfig(): void {
      rightPaneContent.innerHTML = '';
      const wrap = el('div', { class: 'ab-config' });
      if (!automationRow) {
        wrap.append(el('p', { class: 'ab-muted ab-config-loading' }, 'Loading automation…'));
        rightPaneContent.append(wrap);
        return;
      }
      const m = automationRow.manifest;
      const enabled = automationRow.enabled === true;

      wrap.append(
        el('div', { class: 'ab-config-head' }, [
          el('div', { class: 'ab-config-title' }, m.name || automationRow.id),
          el(
            'span',
            { class: 'ab-chip', 'data-on': String(enabled) },
            enabled ? 'Enabled' : 'Draft',
          ),
        ]),
      );

      wrap.append(
        el('div', { class: 'ab-section' }, [
          el('div', { class: 'ab-section-label' }, 'What it does'),
          el('p', { class: 'ab-prompt' }, m.prompt || 'Not described yet.'),
        ]),
      );

      const triggersBody = el('div', { class: 'ab-triggers' });
      if (m.triggers.length === 0) {
        triggersBody.append(el('p', { class: 'ab-muted' }, 'Manual runs only — no schedule.'));
      } else {
        for (const t of m.triggers) {
          if (t.kind === 'cron') {
            const card = el('div', { class: 'ab-trigger' }, [
              el('div', { class: 'ab-trigger-main' }, [
                el('span', { class: 'ab-trigger-icon', trustedHtml: Icon.History({ size: 14 }) }),
                el('span', { class: 'ab-trigger-desc' }, describeCron(t.expr)),
                el('code', { class: 'ab-trigger-expr' }, t.expr),
              ]),
            ]);
            const next = cronNextRuns(t.expr, 3);
            if (next.length > 0) {
              card.append(
                el('div', { class: 'ab-nextruns' }, [
                  el('span', { class: 'ab-muted' }, 'Next: '),
                  ...next.map((d) =>
                    el(
                      'span',
                      { class: 'ab-nextrun' },
                      d.toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      }),
                    ),
                  ),
                ]),
              );
            }
            triggersBody.append(card);
          } else {
            // A webhook trigger is either provisioned (carries a minted
            // route id) or still pending — the builder mints id + secret
            // on the next agent turn.
            const pending = t.id === undefined;
            const card = el('div', { class: 'ab-trigger' }, [
              el('div', { class: 'ab-trigger-main' }, [
                el('span', { class: 'ab-trigger-icon', trustedHtml: Icon.Globe({ size: 14 }) }),
                el(
                  'span',
                  { class: 'ab-trigger-desc' },
                  pending ? 'Webhook trigger — provisioning…' : 'Webhook trigger',
                ),
                ...(pending ? [] : [el('code', { class: 'ab-trigger-expr' }, `/${t.id}`)]),
              ]),
            ]);
            if (pending) {
              card.append(
                el('div', { class: 'ab-nextruns' }, [
                  el('span', { class: 'ab-muted' }, 'A URL + secret are minted server-side.'),
                ]),
              );
            }
            triggersBody.append(card);
          }
        }
      }
      wrap.append(
        el('div', { class: 'ab-section' }, [
          el('div', { class: 'ab-section-label' }, 'When it runs'),
          triggersBody,
        ]),
      );

      const behavior = el('div', { class: 'ab-rows' });
      behavior.append(cfgRow('Model', m.requires.model || 'Workspace default'));
      behavior.append(cfgRow('Run history', fmtRetention(m.history.keep)));
      if (m.onFailure) behavior.append(cfgRow('On failure', `Run "${m.onFailure}"`));
      const tools = m.requires.tools ?? [];
      if (tools.length > 0) behavior.append(cfgRow('Tools', tools.join(', ')));
      wrap.append(
        el('div', { class: 'ab-section' }, [
          el('div', { class: 'ab-section-label' }, 'Behavior'),
          behavior,
        ]),
      );

      const apps = m.apps ?? [];
      wrap.append(
        el('div', { class: 'ab-section' }, [
          el('div', { class: 'ab-section-label' }, 'Connected apps'),
          apps.length > 0
            ? el(
                'div',
                { class: 'ab-tags' },
                apps.map((a) => el('span', { class: 'ab-tag' }, a)),
              )
            : el('p', { class: 'ab-muted' }, 'Not linked to any app.'),
        ]),
      );

      wrap.append(
        el(
          'div',
          { class: 'ab-hint' },
          'This view is filled in by the chat. Describe any change in the conversation.',
        ),
      );
      rightPaneContent.append(wrap);
    }

    // Test-run pane — a "Run once" affordance plus the recent run history.
    function renderRuns(): void {
      rightPaneContent.innerHTML = '';
      const wrap = el('div', { class: 'ab-runs' });

      const runBtn = el('button', {
        class: 'btn btn-primary ab-runbtn',
        trustedHtml: Icon.Play({ size: 12 }) + '<span>Run once</span>',
        onClick: () => {
          void runAutomationOnce();
        },
      });
      if (automationBusy) runBtn.setAttribute('disabled', '');
      wrap.append(
        el('div', { class: 'ab-runs-head' }, [
          el('div', { class: 'ab-runs-head-text' }, [
            el('div', { class: 'ab-section-label' }, 'Test run'),
            el(
              'p',
              { class: 'ab-muted' },
              'Fire the automation once now, without waiting for the schedule.',
            ),
          ]),
          runBtn,
        ]),
      );

      const list = el('div', { class: 'ab-runlist' }, [
        el('p', { class: 'ab-muted' }, 'Loading runs…'),
      ]);
      wrap.append(
        el('div', { class: 'ab-section' }, [
          el('div', { class: 'ab-section-label' }, 'Recent runs'),
          list,
        ]),
      );
      rightPaneContent.append(wrap);

      if (!appId || !automationRow) return;
      void listAutomationRuns({ automationId: automationRow.ref, limit: 20 })
        .then((runs) => {
          list.innerHTML = '';
          if (runs.length === 0) {
            list.append(el('p', { class: 'ab-muted' }, 'No runs yet. Use "Run once" to test it.'));
            return;
          }
          for (const r of runs) {
            const dur =
              r.endedAt !== undefined ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : '—';
            list.append(
              el('div', { class: 'ab-runrow', 'data-ok': String(r.ok) }, [
                el('span', { class: 'ab-run-dot', 'data-ok': String(r.ok) }),
                el(
                  'span',
                  { class: 'ab-run-summary' },
                  r.summary || r.error || (r.ok ? 'Completed' : 'Failed'),
                ),
                el('span', { class: 'ab-run-trigger' }, r.triggerKind),
                el('span', { class: 'ab-run-meta' }, `${dur} · ${relTime(r.startedAt)}`),
              ]),
            );
          }
        })
        .catch(() => {
          list.innerHTML = '';
          list.append(el('p', { class: 'ab-muted' }, 'Could not load run history.'));
        });
    }

    // ---------- Publish ----------
    async function handlePublish(): Promise<void> {
      if (!appId) {
        showToast('No app to publish');
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
        const result = await publish({ id: appId });
        lastPublishedVersionId = result.versionId;
        liveUrl = (await appLiveUrl({ id: appId })).url;
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
            appId,
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
        } else if (/no_changes|no staged changes/i.test(msg)) {
          // The draft is byte-identical to the live version — nothing to
          // publish. Common right after a clone/scaffold (which already
          // landed a baseline on `main`) when the user hits Publish before
          // making any edits. This isn't a failure; surface it calmly.
          updateMessage(statusIdx, {
            kind: 'status',
            text: 'Already up to date — no changes to publish since the last version.',
          });
          showToast('No changes to publish.');
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
    // owns its own header (app meta + Publish), the right pane
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
      activeId: opts.appId,
      apps: sidebarApps,
      // Drafts come from the shell's hydrated cache (passed via
      // BuilderOptions). Older callers may omit them — default to empty.
      // The currently-open app will appear here too when it's a draft,
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
      // Chats has no dedicated creation surface yet — the section `+`
      // routes back to Home where a new conversation can be started.
      onNewChat: handleExit,
      onSearch: () => window.Centraid?.openSearch?.(),
      onDiscover: () => window.Centraid?.openDiscover?.(),
      onStarred: () => window.Centraid?.openStarred?.(),
      onAutomations: () => window.Centraid?.openAutomations?.(),
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
      // The chat pane only exists on the Preview surface — Code + Cloud
      // are full-focus surfaces with no chat — so the toggle is inert
      // there (renderRight forces the pane hidden on those tabs).
      // Automations keep the chat pane on every tab — the conversation
      // is the builder.
      if (!isAutomation && tab !== 'preview') return;
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
      // The app-identity lockup hugs the back/forward arrows (titlebarLead);
      // the app actions — history, more, Publish — ride the trailing
      // edge (titlebarRight). The chat pane no longer carries a header.
      // §B3 — the tabs + URL pill + device pill live in the right pane's
      // own toolbar (`rb-toolbar`), not the window chrome.
      titlebarLead: builderIdentity,
      titlebarRight: builderActions,
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
      // Cancel any in-flight chat turn (the gateway aborts the streamed run).
      agentAbort?.abort();
    };
  }

  window.openBuilder = openBuilder;
})();
