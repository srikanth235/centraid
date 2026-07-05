// governance: allow-repo-hygiene file-size-limit app-chat-widget pending split into mount / history-view / message-renderer modules
// App-scoped agentic chat widget. Floating button at the bottom-right of
// the app view; click opens a slide-out panel with multi-turn conversation.
// The agent runs gateway-side and operates the app's vault data through the
// vault register (vault_sql / vault_invoke).
//
// Rendering mirrors the builder chat (apps/desktop/src/renderer/builder.ts):
// a typed `AppConversationMsg[]` is fully re-rendered on every update, with adjacent
// tool calls folded into one collapsible "tool group" pill, an author chip
// on assistant turns, and a centered "Thinking…" status while the agent
// works. The in-app twist is that each tool row drills in to show the SQL
// and the result table inline. Past chats persist on the gateway and surface
// as a swappable history view inside the same panel.
//
// This module is loaded ahead of `app.js` and exposes `window.AppChat.mount`,
// which the shell calls from `mountUserApp`. Keeping it standalone caps the
// size of `app.ts` and makes the chat widget independently editable.
//
// Issue #141, Phase 3 — unified chat: the panel no longer relays through the
// desktop main process (`main/chat.ts` + `centraid:chat:*` IPC). It streams
// the turn straight from the gateway's `/centraid/<appId>/_turn` SSE and
// consumes the native `TurnStreamEvent` union, and reads/writes chat history
// over the gateway's `/_centraid-conversations` surface directly. Because the
// gateway-side runner runs the turn in the app's draft worktree with the
// union of tools, the same panel both tweaks the app's code and operates its
// data — one chat surface, both jobs.

import {
  streamTurn,
  uploadConversationAttachment,
  createConversation,
  listConversations,
  loadConversation,
  deleteConversation,
  getUserPrefs,
  saveUserPrefs,
  getRunnerStatus,
  getAgentsStatus,
  type TurnStreamEvent,
  type ConversationAttachmentRef,
} from './gateway-client.js';

(function () {
  type AppToolCall = {
    id: string;
    tool: string;
    sql?: string;
    args?: unknown;
    summary?: string;
    state: 'running' | 'ok' | 'error';
    result?: unknown;
    errorText?: string;
    open?: boolean;
  };
  type AppConversationMsg =
    | { kind: 'user'; text: string }
    | { kind: 'ai'; text: string; streaming?: boolean; error?: boolean }
    | { kind: 'toolGroup'; id: string; calls: AppToolCall[]; open: boolean };

  function mount(opts: {
    view: HTMLElement;
    app: AppMetaResolvedType;
    appId: string;
    el: ElHelper;
  }): () => void {
    const { view, app, appId, el } = opts;

    let open = false;
    let nextTurnId = 1;
    let activeTurn: number | null = null;
    // The in-flight turn's abort handle — streamTurn() cancels its fetch when
    // this aborts (Stop button / new chat / panel teardown).
    let abortController: AbortController | null = null;
    let chat: AppConversationMsg[] = [];
    // Files uploaded to the blob CAS, queued for the next turn (issue #190).
    let pendingAttachments: ConversationAttachmentRef[] = [];

    // ---- Coupled Agent · Model picker state ----
    // The composer carries one control that reads "<Agent> · <Model>". The
    // model selection is stored per-runner (`chatModelByRunner`) so it is
    // always scoped to its agent and can never carry across an agent switch.
    // `amModels` holds the catalog for the *active* runner only (that's all
    // runner-status reports), so stale detection applies to the active runner.
    // `openclaw` is a non-switchable runner (a remote OpenClaw gateway drives
    // it; you can't flip to codex/claude from here) — it's shown read-only.
    type RunnerKey = 'codex' | 'claude-code' | 'openclaw';
    type SwitchableKind = 'codex' | 'claude-code';
    const isSwitchable = (k: RunnerKey): k is SwitchableKind =>
      k === 'codex' || k === 'claude-code';
    type AmAgents = Awaited<ReturnType<typeof getAgentsStatus>>;
    type AmModel = NonNullable<Awaited<ReturnType<typeof getRunnerStatus>>['models']>[number];
    type AmModelsStatus = Awaited<ReturnType<typeof getRunnerStatus>>['modelsStatus'];
    let amOpen = false;
    let amLoaded = false;
    let amActiveRunner: RunnerKey = 'codex';
    let amAgents: AmAgents | null = null;
    let amModels: AmModel[] = [];
    // Load state of `amModels`: `loading` while the gateway enumerates (the
    // seed is gone), `ready`/`empty` once it settles. Drives the picker's
    // loading dots / empty state and the poll loop below.
    let amModelsStatus: AmModelsStatus;
    let amSelByRunner: Record<string, string> = {};
    let amSwitching = false;
    let amPollTimer: ReturnType<typeof setTimeout> | undefined;
    let amPollDeadline = 0;
    // Per-turn streaming state. `streamed` accumulates assistant deltas;
    // `hadContent` flips once we've shown any AI text or tool group, which
    // hides the centered "Thinking…" status row.
    const turnState = new Map<
      number,
      {
        streamed: string;
        hadDelta: boolean;
        hadContent: boolean;
        aiIndex: number; // -1 if no AI msg yet
      }
    >();

    const escapeHtml = (s: string): string =>
      s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

    // Inline icons (kept tiny — same shape the builder uses for the tool-group
    // pill) so the in-app chat doesn't need to reach into the builder IIFE.
    const BoltSvg = (size = 13): string =>
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>`;
    const ChevSvg = (size = 13): string =>
      `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;

    function toolVerb(tool: string): string {
      return tool.charAt(0).toUpperCase() + tool.slice(1);
    }

    function summarizeToolArgs(sql?: string, args?: unknown): string | undefined {
      // SQL-carrying tools (vault_sql) surface the statement's first line;
      // everything else falls back to a short string arg.
      if (sql) {
        const firstLine = sql.split('\n').find((l) => l.trim().length > 0) ?? sql;
        return firstLine.trim().replace(/\s+/g, ' ').slice(0, 90);
      }
      if (args && typeof args === 'object') {
        for (const k of ['name', 'path', 'query']) {
          const v = (args as Record<string, unknown>)[k];
          if (typeof v === 'string' && v.length > 0) return v.slice(0, 90);
        }
      }
      return undefined;
    }

    function summarizeGroup(calls: AppToolCall[]): string {
      const segs: { verb: string; count: number }[] = [];
      for (const c of calls) {
        const verb = toolVerb(c.tool);
        const last = segs[segs.length - 1];
        if (last && last.verb === verb) last.count += 1;
        else segs.push({ verb, count: 1 });
      }
      return segs.map((s) => (s.count > 1 ? `${s.verb} ×${s.count}` : s.verb)).join(', ');
    }

    // Session-aware widget state. `currentSessionId` is the persisted chat
    // session this panel is currently showing; `null` means a fresh chat
    // that hasn't been saved yet (it gets a row on first send). `viewMode`
    // toggles between the conversation surface and the history list.
    let currentSessionId: string | null = null;
    let viewMode: 'chat' | 'history' = 'chat';
    let historySessions: CentraidConversationSummary[] = [];
    let historyLoading = false;
    let historySearch = '';

    const Icon = window.Icon;

    // §D2 — ambient copilot FAB. Collapsed by default; a quiet glass pill
    // bottom-right — sparkle in a tinted disc, the app label, and a ⌘J hint
    // so the entry point is legible, not just a glyph.
    const fab = el(
      'button',
      {
        class: 'app-chat-fab',
        type: 'button',
        title: 'Ask about this app',
        'aria-label': `Ask ${app.name}`,
      },
      [
        el('span', { class: 'app-chat-fab-icon', trustedHtml: Icon.Sparkle({ size: 11 }) }),
        el('span', { class: 'app-chat-fab-label' }, `Ask ${app.name}`),
        el('span', { class: 'app-chat-fab-kbd' }, '⌘J'),
      ],
    );

    const panel = el('aside', {
      class: 'app-chat-panel',
      'aria-hidden': 'true',
    });

    // Header controls. Back button — shown only in history view (returns
    // to chat). In chat view its job (opening history) moves into the ⋯
    // overflow (§D3). Close hides the whole panel.
    const headHistoryBtn = el('button', {
      class: 'app-chat-icon-btn',
      type: 'button',
      hidden: '',
      'aria-label': 'Back to chat',
      title: 'Back to chat',
      trustedHtml:
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 4l-4 4 4 4"/></svg>',
      onClick: () => {
        if (viewMode === 'history') setView('chat');
        else void openHistory();
      },
    });
    // §D — copilot header reads as a product surface: a sparkle avatar,
    // "Copilot" title, and a mono app·file sub-context line.
    const headAvatar = el('span', {
      class: 'app-chat-avatar',
      trustedHtml: Icon.Sparkle({ size: 12 }),
    });
    const scopedContext = `scoped · ${app.name.toLowerCase().replace(/\s+/g, '-')}.app`;
    const headSub = el('span', { class: 'app-chat-sub' }, scopedContext);
    // The header title is a static "Copilot"; the mono sub-line carries
    // either the active chat's title or the default scoped app context.
    const setHeadContext = (chatTitle: string | null): void => {
      headSub.textContent = chatTitle && chatTitle.trim() ? chatTitle : scopedContext;
    };
    const headTitle = el('div', { class: 'app-chat-title' }, [
      el('span', { class: 'app-chat-title-text' }, 'Copilot'),
      headSub,
    ]);
    // Minimize collapses the panel back to the ambient FAB.
    const headCloseBtn = el('button', {
      class: 'app-chat-icon-btn app-chat-close',
      type: 'button',
      'aria-label': 'Minimize',
      title: 'Minimize',
      trustedHtml:
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14 6l-6 6 6 6"/></svg>',
      onClick: () => toggle(false),
    });

    // §D3 — secondary header actions (New chat, Chat history) collapse
    // into a ⋯ overflow so the copilot header reads calmly: title · ⋯ · ×.
    const overflowMenu = el('div', { class: 'app-chat-overflow-menu', hidden: '' });
    const overflowItem = (label: string, onClick: () => void): HTMLElement =>
      el(
        'button',
        {
          class: 'app-chat-overflow-item',
          type: 'button',
          onClick: () => {
            overflowMenu.setAttribute('hidden', '');
            onClick();
          },
        },
        label,
      );
    overflowMenu.append(
      overflowItem('New chat', () => void startNewChat()),
      overflowItem('Chat history', () => void openHistory()),
    );
    const overflowBtn = el('button', {
      class: 'app-chat-icon-btn',
      type: 'button',
      'aria-label': 'More actions',
      title: 'More',
      trustedHtml:
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="19" cy="12" r="1.9"/></svg>',
    });
    overflowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (overflowMenu.hasAttribute('hidden')) overflowMenu.removeAttribute('hidden');
      else overflowMenu.setAttribute('hidden', '');
    });
    document.addEventListener('click', () => overflowMenu.setAttribute('hidden', ''), {
      capture: true,
    });
    const overflowWrap = el('div', { class: 'app-chat-overflow-wrap' }, [
      overflowBtn,
      overflowMenu,
    ]);

    const head = el('div', { class: 'app-chat-head' }, [
      headHistoryBtn,
      headAvatar,
      headTitle,
      el('div', { class: 'app-chat-head-actions' }, [overflowWrap, headCloseBtn]),
    ]);
    // chat-scroll mirrors the builder; the panel-specific padding override
    // lives in styles.css under `.app-chat-panel .chat-scroll`.
    const scroll = el('div', { class: 'chat-scroll app-chat-scroll' });
    // §D1 — the empty state leads with an intro card: a one-line "Chat
    // with your <app> data." headline, an explainer, and tappable prompt
    // chips that drop into the composer, so a fresh copilot pane is never
    // a blank box.
    const starterPrompts = [
      'What can this app do?',
      'Show me all the records',
      'Summarize the data',
    ];
    const starterRow = el('div', { class: 'app-chat-starters' });
    for (const prompt of starterPrompts) {
      starterRow.append(
        el(
          'button',
          {
            class: 'app-chat-starter',
            type: 'button',
            onClick: () => {
              input.value = prompt;
              input.dispatchEvent(new Event('input'));
              input.focus();
            },
          },
          prompt,
        ),
      );
    }
    const emptyTitle = el('div', { class: 'app-chat-empty-title' });
    emptyTitle.innerHTML = `Chat with your <span class="app-chat-empty-accent">${escapeHtml(app.name)}</span> data.`;
    // Recent-chats list inside the empty state — hydrated lazily from the
    // gateway when the panel first opens, so a fresh copilot surfaces past
    // conversations without a trip through the ⋯ menu.
    const recentList = el('div', { class: 'app-chat-recent-list' });
    const recentBlock = el('div', { class: 'app-chat-recent', hidden: '' }, [
      el('div', { class: 'app-chat-recent-label' }, 'Recent chats'),
      recentList,
    ]);
    const empty = el('div', { class: 'app-chat-empty' }, [
      el('div', { class: 'app-chat-intro-card' }, [
        emptyTitle,
        el(
          'p',
          { class: 'app-chat-empty-hint' },
          'Ask questions, add items by talking, or have the assistant update or delete records for you.',
        ),
        starterRow,
      ]),
      recentBlock,
    ]);

    // History view chrome — list of past sessions with a search input and
    // grouped time buckets. Hidden by default; toggled by setView('history').
    const historyWrap = el('div', { class: 'app-chat-history', hidden: '' });
    const historySearchInput = el('input', {
      class: 'app-chat-history-search',
      type: 'search',
      placeholder: 'Search chats…',
      'aria-label': 'Search chats',
    }) as HTMLInputElement;
    historySearchInput.addEventListener('input', () => {
      historySearch = historySearchInput.value;
      renderHistory();
    });
    const historyList = el('div', { class: 'app-chat-history-list' });
    historyWrap.append(
      el('div', { class: 'app-chat-history-searchwrap' }, [historySearchInput]),
      historyList,
    );

    const input = el('textarea', {
      class: 'app-chat-textarea',
      placeholder: 'Ask about this app’s data…',
      rows: '1',
    }) as HTMLTextAreaElement;
    const sendBtn = el('button', {
      class: 'app-chat-send',
      type: 'button',
      title: 'Send',
      'aria-label': 'Send',
      trustedHtml: Icon.ArrowRight({ size: 14 }),
    }) as HTMLButtonElement;
    // Stop button swaps in for Send while a turn is active. The renderer
    // keeps both nodes mounted and toggles `hidden`, which avoids a layout
    // shift each time the user submits.
    const stopBtn = el('button', {
      class: 'app-chat-send app-chat-stop',
      type: 'button',
      title: 'Stop',
      'aria-label': 'Stop',
      hidden: '',
      trustedHtml:
        '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5"/></svg>',
      onClick: () => {
        abortController?.abort();
      },
    }) as HTMLButtonElement;
    // Composer card — the textarea sits above a toolbar row carrying a
    // paperclip affordance, a ⌘↵ keycap hint, and the accent send button.
    const attachBtn = el('button', {
      class: 'app-chat-attach',
      type: 'button',
      'aria-label': 'Attach',
      title: 'Attach',
      trustedHtml:
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    });
    // Attachments uploaded ahead of the next turn (issue #190). The bytes land
    // in the app's blob CAS on pick; the refs ride the next `streamTurn` send.
    const attachChips = el('div', { class: 'app-chat-attach-chips' });
    const renderAttachChips = (): void => {
      attachChips.replaceChildren(
        ...pendingAttachments.map((a) =>
          el('span', { class: 'app-chat-attach-chip', title: a.filename ?? a.mime }, [
            `${a.filename ?? a.mime} `,
            el(
              'button',
              {
                type: 'button',
                'aria-label': 'Remove attachment',
                onClick: () => {
                  pendingAttachments = pendingAttachments.filter((p) => p !== a);
                  renderAttachChips();
                },
              },
              '×',
            ),
          ]),
        ),
      );
    };
    const fileInput = el('input', {
      type: 'file',
      multiple: true,
      style: { display: 'none' },
    }) as HTMLInputElement;
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = '';
      void Promise.all(
        files.map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const ref = await uploadConversationAttachment(
            appId,
            bytes,
            file.type || 'application/octet-stream',
            file.name,
          );
          pendingAttachments.push(ref);
          renderAttachChips();
        }),
      ).catch(() => undefined);
    });
    attachBtn.addEventListener('click', () => fileInput.click());
    // ---- Coupled Agent · Model control ----
    // One pill that reads "<Agent> · <Model>". Opening it reveals the agents
    // (switching the active runner is a gateway-wide change) and, below, the
    // active runner's own models. Because the selection is keyed per-runner,
    // an agent switch can never leave a foreign model id selected; a model
    // that's gone stale within its runner is shown as an explicit
    // "unavailable" state with one-click repair, never silently re-sent.
    const AM_ACCENT: Record<RunnerKey, string> = {
      codex: '#10b981',
      'claude-code': '#a855f7',
      openclaw: '#4950f6',
    };
    const AM_TITLE: Record<RunnerKey, string> = {
      codex: 'Codex',
      'claude-code': 'Claude Code',
      openclaw: 'OpenClaw',
    };
    const AM_BIN: Record<RunnerKey, string> = {
      codex: 'codex',
      'claude-code': 'claude',
      openclaw: 'openclaw',
    };
    const AM_TIERS: Array<[NonNullable<AmModel['tier']>, string]> = [
      ['smart', 'Most capable'],
      ['balanced', 'Balanced'],
      ['fast', 'Fastest'],
    ];
    const amCaret =
      '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    const amRefreshIcon =
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';

    const amTrigger = el('button', {
      class: 'app-chat-am-trigger',
      type: 'button',
      'aria-haspopup': 'true',
      'aria-expanded': 'false',
      title: 'Agent and model',
      onClick: (e: Event) => {
        e.stopPropagation();
        toggleAm();
      },
    }) as HTMLButtonElement;
    const amPop = el('div', {
      class: 'app-chat-am-pop',
      role: 'menu',
      'aria-label': 'Agent and model',
    });
    const amWrap = el('div', { class: 'app-chat-am' }, [amTrigger, amPop]);

    const amAgentAvailable = (kind: RunnerKey): boolean =>
      kind === 'codex' ? !!amAgents?.codexAvailable : !!amAgents?.claudeAvailable;
    const amAgentVersion = (kind: RunnerKey): string | undefined =>
      kind === 'codex' ? amAgents?.codexVersion : amAgents?.claudeVersion;

    // The active runner's current selection: a gateway default, a valid pinned
    // model, or a pinned id no longer offered by the runner (stale).
    function amSelection(): { mode: 'default' | 'pinned' | 'stale'; id: string; model?: AmModel } {
      const saved = amSelByRunner[amActiveRunner];
      if (!saved) return { mode: 'default', id: '' };
      const model = amModels.find((m) => m.id === saved);
      return model ? { mode: 'pinned', id: saved, model } : { mode: 'stale', id: saved };
    }
    const amModelName = (m: AmModel): string => m.name ?? m.id;

    function renderAmTrigger(): void {
      const accent = AM_ACCENT[amActiveRunner];
      amTrigger.style.setProperty('--am-accent', accent);
      amPop.style.setProperty('--am-accent', accent);
      const sel = amSelection();
      // While the model list is still being discovered and nothing is pinned,
      // say so rather than implying a concrete default. Send stays enabled —
      // a turn with no pinned model runs on the runner's built-in default.
      const discovering = amModelsStatus === 'loading' && amModels.length === 0;
      const modelNode =
        sel.mode === 'default'
          ? discovering
            ? el('span', { class: 'app-chat-am-discovering' }, 'Discovering…')
            : el('span', {}, 'Gateway default')
          : sel.mode === 'pinned'
            ? el('span', {}, amModelName(sel.model as AmModel))
            : el('span', { class: 'app-chat-am-warn', title: `${sel.id} is no longer available` }, [
                '⚠ ',
                sel.id,
              ]);
      amTrigger.replaceChildren(
        el('span', { class: 'app-chat-am-seg app-chat-am-agent' }, [
          el('span', { class: 'app-chat-am-dot', style: { background: accent } }),
          AM_TITLE[amActiveRunner],
        ]),
        el('span', { class: 'app-chat-am-seg app-chat-am-model' }, [
          modelNode,
          el('span', { class: 'app-chat-am-caret', trustedHtml: amCaret }),
        ]),
      );
    }

    // Read-only card for a non-switchable active runner (a remote OpenClaw
    // gateway): show it as the agent without offering codex/claude switches.
    function amAgentSoloCard(): HTMLElement {
      const card = el('div', { class: 'app-chat-am-agentcard', 'aria-pressed': 'true' }, [
        el('span', { class: 'app-chat-am-ac-top' }, [
          el('span', {
            class: 'app-chat-am-dot',
            style: { background: AM_ACCENT[amActiveRunner] },
          }),
          el('span', { class: 'app-chat-am-ac-name' }, AM_TITLE[amActiveRunner]),
        ]),
        el('span', { class: 'app-chat-am-ac-meta' }, 'active runner'),
      ]);
      card.style.setProperty('--am-accent', AM_ACCENT[amActiveRunner]);
      return card;
    }

    function amAgentCard(kind: SwitchableKind): HTMLElement {
      const active = kind === amActiveRunner;
      const available = amAgentAvailable(kind);
      const version = amAgentVersion(kind);
      const meta = !available
        ? 'not found'
        : version
          ? `${AM_BIN[kind]} · ${version}`
          : AM_BIN[kind];
      const card = el(
        'button',
        {
          class: 'app-chat-am-agentcard',
          type: 'button',
          'aria-pressed': active ? 'true' : 'false',
          ...(available && !active ? {} : { disabled: '' }),
          onClick: () => void amSwitchAgent(kind),
        },
        [
          el('span', { class: 'app-chat-am-ac-top' }, [
            el('span', { class: 'app-chat-am-dot', style: { background: AM_ACCENT[kind] } }),
            el('span', { class: 'app-chat-am-ac-name' }, AM_TITLE[kind]),
          ]),
          el('span', { class: 'app-chat-am-ac-meta' }, meta),
          active ? el('span', { class: 'app-chat-am-ac-active' }, 'ACTIVE') : false,
        ],
      );
      card.style.setProperty('--am-accent', AM_ACCENT[kind]);
      return card;
    }

    function amOptionRow(opts: {
      label: string;
      id: string;
      selected: boolean;
      hint?: string;
      isDefault?: boolean;
      onChoose: () => void;
    }): HTMLElement {
      return el(
        'button',
        {
          class: 'app-chat-am-opt',
          type: 'button',
          role: 'menuitemradio',
          'aria-checked': opts.selected ? 'true' : 'false',
          onClick: opts.onChoose,
        },
        [
          el('span', { class: 'app-chat-am-check' }, opts.selected ? '✓' : ''),
          el('span', { class: 'app-chat-am-opt-lab' }, [
            opts.label,
            opts.hint ? el('small', {}, ` · ${opts.hint}`) : false,
          ]),
          opts.id ? el('span', { class: 'app-chat-am-opt-id' }, opts.id) : false,
          opts.isDefault ? el('span', { class: 'app-chat-am-tag' }, 'default') : false,
        ],
      );
    }

    function renderAmPop(): void {
      if (!amLoaded) {
        amPop.replaceChildren(el('div', { class: 'app-chat-am-loading' }, 'Loading agents…'));
        return;
      }
      const sel = amSelection();
      const children: Array<HTMLElement | false> = [
        el('div', { class: 'app-chat-am-seclabel' }, 'Agent'),
        isSwitchable(amActiveRunner)
          ? el('div', { class: 'app-chat-am-agentgrid' }, [
              amAgentCard('codex'),
              amAgentCard('claude-code'),
            ])
          : amAgentSoloCard(),
        el('div', { class: 'app-chat-am-divider' }),
        el('div', { class: 'app-chat-am-modelhead' }, [
          el('span', { class: 'app-chat-am-modelfor' }, `Models for ${AM_TITLE[amActiveRunner]}`),
          el(
            'button',
            {
              class:
                amModelsStatus === 'loading'
                  ? 'app-chat-am-refresh app-chat-am-busy'
                  : 'app-chat-am-refresh',
              type: 'button',
              title: 'Re-enumerate from the runner',
              onClick: () => void amRefresh(),
            },
            [
              el('span', { class: 'app-chat-am-refresh-icon', trustedHtml: amRefreshIcon }),
              'Refresh',
            ],
          ),
        ]),
      ];

      if (sel.mode === 'stale') {
        const def = amModels.find((m) => m.default) ?? amModels[0];
        children.push(
          el('div', { class: 'app-chat-am-stale' }, [
            el('span', {}, `Saved model `),
            el('b', {}, sel.id),
            el(
              'span',
              {},
              ` isn’t offered by ${AM_TITLE[amActiveRunner]} anymore. It won’t be sent.`,
            ),
            el('div', { class: 'app-chat-am-stale-fix' }, [
              def
                ? el(
                    'button',
                    {
                      class: 'app-chat-am-stale-btn primary',
                      type: 'button',
                      onClick: () => void amSelectModel(def.id),
                    },
                    `Use ${amModelName(def)}`,
                  )
                : false,
              el(
                'button',
                {
                  class: 'app-chat-am-stale-btn',
                  type: 'button',
                  onClick: () => void amSelectModel(''),
                },
                'Gateway default',
              ),
            ]),
          ]),
        );
      }

      const list = el('div', { class: 'app-chat-am-modellist' });
      list.append(
        amOptionRow({
          label: 'Gateway default',
          id: '',
          hint: 'runner decides',
          selected: sel.mode === 'default',
          onChoose: () => void amSelectModel(''),
        }),
      );
      if (amModels.length === 0 && amModelsStatus === 'loading') {
        // Discovering and nothing cached yet — pulsing dots. Gateway default
        // above stays selectable so the user is never blocked.
        list.append(
          el('div', { class: 'app-chat-am-loadrow' }, [
            el('div', { class: 'app-chat-am-loaddots' }, [el('i'), el('i'), el('i')]),
            el('span', {}, `Discovering ${AM_TITLE[amActiveRunner]} models…`),
          ]),
        );
      } else if (amModels.length === 0) {
        // Enumerated empty / CLI unavailable — not an error, just nothing to pin.
        list.append(
          el(
            'div',
            { class: 'app-chat-am-empty' },
            `No models reported by ${AM_TITLE[amActiveRunner]}.`,
          ),
        );
      } else {
        const tiered = amModels.some((m) => m.tier);
        if (tiered) {
          for (const [tier, label] of AM_TIERS) {
            const inTier = amModels.filter((m) => m.tier === tier);
            if (!inTier.length) continue;
            list.append(el('div', { class: 'app-chat-am-tierlabel' }, label));
            for (const m of inTier) {
              list.append(
                amOptionRow({
                  label: amModelName(m),
                  id: m.id,
                  isDefault: m.default,
                  selected: sel.mode === 'pinned' && sel.id === m.id,
                  onChoose: () => void amSelectModel(m.id),
                }),
              );
            }
          }
        } else {
          for (const m of amModels) {
            list.append(
              amOptionRow({
                label: amModelName(m),
                id: m.id,
                isDefault: m.default,
                selected: sel.mode === 'pinned' && sel.id === m.id,
                onChoose: () => void amSelectModel(m.id),
              }),
            );
          }
        }
      }
      children.push(list);
      amPop.replaceChildren(...children.filter((c): c is HTMLElement => c !== false));
    }

    function amClearPoll(): void {
      if (amPollTimer) {
        clearTimeout(amPollTimer);
        amPollTimer = undefined;
      }
    }
    // Poll runner-status while the gateway is still enumerating models so the
    // picker fills in (or a Refresh swaps in the new list) without the user
    // doing anything. Bounded by `amPollDeadline` so a dead warm can't spin.
    function amSchedulePoll(): void {
      amClearPoll();
      if (amModelsStatus === 'loading' && Date.now() < amPollDeadline) {
        amPollTimer = setTimeout(() => void amLoad({ poll: true }), 800);
      }
    }

    async function amLoad(opts: { refresh?: boolean; poll?: boolean } = {}): Promise<void> {
      const [prefs, agents, status, settings] = await Promise.all([
        getUserPrefs().catch(() => ({}) as Record<string, unknown>),
        getAgentsStatus().catch(() => null),
        getRunnerStatus(opts.refresh ? { refresh: true } : {}).catch(() => null),
        window.CentraidApi.getSettings().catch(() => null),
      ]);
      // Trust the gateway's reported runner kind (incl. `openclaw`) so a remote
      // OpenClaw gateway isn't mislabelled as codex and its model isn't saved
      // under a fake key. Fall back to the local agent pref only when the
      // gateway didn't report a usable kind.
      const statusKind = status?.kind;
      amActiveRunner =
        statusKind === 'claude-code' || statusKind === 'codex' || statusKind === 'openclaw'
          ? statusKind
          : prefs['agent.runner.kind'] === 'claude-code'
            ? 'claude-code'
            : 'codex';
      amAgents = agents;
      amModels = status?.models ?? [];
      amModelsStatus = status?.modelsStatus;
      amSelByRunner = settings?.chatModelByRunner ?? {};
      amLoaded = true;
      // A fresh (non-poll) load opens a new polling window; polls reuse it.
      if (!opts.poll) amPollDeadline = Date.now() + 30_000;
      renderAmTrigger();
      renderAmPop();
      amSchedulePoll();
    }

    async function amSwitchAgent(kind: SwitchableKind): Promise<void> {
      if (kind === amActiveRunner || amSwitching || !amAgentAvailable(kind)) return;
      amSwitching = true;
      renderAmPop();
      try {
        await saveUserPrefs({ 'agent.runner.kind': kind });
        amActiveRunner = kind;
        // Re-enumerate so the model list + selection reflect the new runner.
        await amLoad({ refresh: true });
      } catch {
        /* keep the prior runner; the pop re-renders below */
      } finally {
        amSwitching = false;
        renderAmTrigger();
        renderAmPop();
      }
    }

    async function amSelectModel(id: string): Promise<void> {
      // Optimistic local update, then persist just this runner's entry.
      if (id) amSelByRunner = { ...amSelByRunner, [amActiveRunner]: id };
      else {
        const next = { ...amSelByRunner };
        delete next[amActiveRunner];
        amSelByRunner = next;
      }
      renderAmTrigger();
      closeAm();
      try {
        await window.CentraidApi.saveSettings({ chatModelByRunner: { [amActiveRunner]: id } });
      } catch {
        /* best-effort; the next open reconciles from disk */
      }
    }

    async function amRefresh(): Promise<void> {
      amTrigger.classList.add('app-chat-am-busy');
      try {
        await amLoad({ refresh: true });
      } finally {
        amTrigger.classList.remove('app-chat-am-busy');
      }
    }

    function openAm(): void {
      amOpen = true;
      amPop.classList.add('open');
      amTrigger.setAttribute('aria-expanded', 'true');
      if (!amLoaded) {
        renderAmPop();
        void amLoad();
      } else {
        renderAmPop();
      }
    }
    function closeAm(): void {
      amOpen = false;
      amPop.classList.remove('open');
      amTrigger.setAttribute('aria-expanded', 'false');
    }
    function toggleAm(): void {
      if (amOpen) closeAm();
      else openAm();
    }
    const onAmDocClick = (e: MouseEvent): void => {
      if (amOpen && !amWrap.contains(e.target as Node)) closeAm();
    };
    const onAmEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && amOpen) closeAm();
    };
    document.addEventListener('click', onAmDocClick);
    document.addEventListener('keydown', onAmEsc);
    renderAmTrigger();

    const inputTools = el('div', { class: 'app-chat-input-tools' }, [
      attachBtn,
      fileInput,
      attachChips,
      amWrap,
      el('span', { class: 'app-chat-input-spacer' }),
      el('span', { class: 'app-chat-input-kbd' }, '⌘↵'),
      sendBtn,
      stopBtn,
    ]);
    const inputWrap = el('form', { class: 'app-chat-input-wrap' }, [input, inputTools]);
    inputWrap.addEventListener('submit', (e) => {
      e.preventDefault();
      void submit();
    });

    panel.append(head, scroll, historyWrap, inputWrap);
    view.append(fab, panel);
    scroll.append(empty);

    function toggle(next?: boolean): void {
      open = next ?? !open;
      panel.classList.toggle('open', open);
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
      fab.classList.toggle('hidden', open);
      if (open) {
        void loadRecentChats();
        // Populate the Agent · Model pill so the composer shows the live
        // active agent + its model the moment the panel opens.
        if (!amLoaded) void amLoad();
        setTimeout(() => input.focus(), 60);
      }
    }

    fab.addEventListener('click', () => toggle(true));

    // §D2 — ⌘J toggles the copilot from anywhere in the app view.
    const onGlobalKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        toggle();
      }
    };
    document.addEventListener('keydown', onGlobalKey);

    function setView(next: 'chat' | 'history'): void {
      viewMode = next;
      const onHistory = next === 'history';
      panel.classList.toggle('view-history', onHistory);
      historyWrap.hidden = !onHistory;
      scroll.hidden = onHistory;
      inputWrap.hidden = onHistory;
      // The back button shows only in history view; the ⋯ overflow shows
      // only in chat view (§D3).
      headHistoryBtn.hidden = !onHistory;
      overflowWrap.hidden = onHistory;
      if (onHistory) historySearchInput.focus();
    }

    async function openHistory(): Promise<void> {
      setView('history');
      historyLoading = true;
      renderHistory();
      try {
        historySessions = await listConversations(appId);
      } catch (err) {
        historySessions = [];
        console.warn('chat history list failed', err);
      } finally {
        historyLoading = false;
        renderHistory();
      }
    }

    /** Cancel any in-flight turn so a session switch doesn't keep streaming
     *  into a now-orphaned conversation. */
    function abortActiveTurn(): void {
      if (activeTurn !== null) {
        abortController?.abort();
        activeTurn = null;
        setBusy(false);
      }
    }

    async function startNewChat(): Promise<void> {
      abortActiveTurn();
      // A fresh chat gets its session row lazily on first send (submit()).
      currentSessionId = null;
      chat = [];
      turnState.clear();
      setHeadContext(null);
      setView('chat');
      renderChat();
      input.focus();
    }

    async function resumeSession(meta: CentraidConversationSummary): Promise<void> {
      abortActiveTurn();
      currentSessionId = meta.id;
      chat = [];
      turnState.clear();
      setHeadContext(meta.title || null);
      setView('chat');
      // Show a loading placeholder while we hydrate.
      scroll.innerHTML = '';
      scroll.append(
        el('div', { class: 'app-chat-loading' }, [
          el('span', { class: 'pulse' }),
          ' Loading chat…',
        ]),
      );
      try {
        const loaded = await loadConversation(appId, meta.id);
        chat = hydrateMessages(loaded.messages);
      } catch (err) {
        appendError(`Failed to load chat: ${String(err)}`);
        return;
      }
      renderChat();
    }

    /**
     * Rebuild the renderer's `AppConversationMsg[]` from the coarse-grained persisted
     * messages: consecutive `tool` rows fold into a single toolGroup so the
     * UI matches what the user saw live.
     */
    function hydrateMessages(
      rows: Array<{ idx: number; payload: CentraidConversationHistoryMessage }>,
    ): AppConversationMsg[] {
      const out: AppConversationMsg[] = [];
      for (const { payload } of rows) {
        if (payload.kind === 'user') {
          out.push({ kind: 'user', text: payload.text });
        } else if (payload.kind === 'ai') {
          out.push({ kind: 'ai', text: payload.text, error: payload.error });
        } else if (payload.kind === 'tool') {
          const call: AppToolCall = {
            id: payload.id,
            tool: payload.tool,
            sql: payload.sql,
            args: payload.args,
            summary: summarizeToolArgs(payload.sql, payload.args),
            state: payload.state,
            result: payload.result,
            errorText: payload.errorText,
          };
          const last = out[out.length - 1];
          if (last && last.kind === 'toolGroup') {
            out[out.length - 1] = { ...last, calls: [...last.calls, call] };
          } else {
            out.push({ kind: 'toolGroup', id: call.id, calls: [call], open: false });
          }
        }
      }
      return out;
    }

    function relativeTime(updatedAt: number, now = Date.now()): string {
      const diff = Math.max(0, now - updatedAt);
      const m = Math.floor(diff / 60_000);
      if (m < 1) return 'just now';
      if (m < 60) return `${m} min ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      if (d < 7) return `${d}d ago`;
      const w = Math.floor(d / 7);
      if (w < 5) return `${w}w ago`;
      const mo = Math.floor(d / 30);
      if (mo < 12) return `${mo}mo ago`;
      const y = Math.floor(d / 365);
      return `${y}y ago`;
    }

    function bucketFor(updatedAt: number, now = Date.now()): string {
      const day = 86_400_000;
      const startOfToday = new Date(now);
      startOfToday.setHours(0, 0, 0, 0);
      const startOfTodayMs = startOfToday.getTime();
      if (updatedAt >= startOfTodayMs) return 'Today';
      if (updatedAt >= startOfTodayMs - day) return 'Yesterday';
      if (updatedAt >= startOfTodayMs - 7 * day) return 'This week';
      if (updatedAt >= startOfTodayMs - 30 * day) return 'This month';
      return 'Earlier';
    }

    function renderHistory(): void {
      historyList.innerHTML = '';
      if (historyLoading) {
        historyList.append(el('div', { class: 'app-chat-history-empty' }, 'Loading…'));
        return;
      }
      const q = historySearch.trim().toLowerCase();
      const filtered = q
        ? historySessions.filter((s) => s.title.toLowerCase().includes(q))
        : historySessions;
      if (filtered.length === 0) {
        historyList.append(
          el(
            'div',
            { class: 'app-chat-history-empty' },
            q ? 'No chats match your search.' : 'No saved chats yet.',
          ),
        );
        return;
      }
      const now = Date.now();
      let currentBucket = '';
      for (const s of filtered) {
        const bucket = bucketFor(s.updatedAt, now);
        if (bucket !== currentBucket) {
          currentBucket = bucket;
          historyList.append(el('div', { class: 'app-chat-history-group' }, bucket));
        }
        const titleText = s.title || '(untitled chat)';
        const row = el('div', { class: 'app-chat-history-row' });
        const main = el(
          'button',
          {
            class: 'app-chat-history-rowmain',
            type: 'button',
            onClick: () => {
              void resumeSession(s);
            },
          },
          [
            el('div', { class: 'app-chat-history-title' }, titleText),
            el('div', { class: 'app-chat-history-meta' }, relativeTime(s.updatedAt, now)),
          ],
        );
        const del = el('button', {
          class: 'app-chat-history-del',
          type: 'button',
          'aria-label': 'Delete chat',
          title: 'Delete chat',
          trustedHtml:
            '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M5 4l1 9a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1l1-9"/></svg>',
          onClick: (e: Event) => {
            e.stopPropagation();
            void deleteSession(s);
          },
        });
        row.append(main, del);
        historyList.append(row);
      }
    }

    async function deleteSession(s: CentraidConversationSummary): Promise<void> {
      try {
        await deleteConversation(appId, s.id);
        historySessions = historySessions.filter((x) => x.id !== s.id);
        renderHistory();
        // If we just deleted the chat the user is currently viewing, reset
        // the panel to a fresh chat so they don't keep sending into a dead
        // gateway session.
        if (currentSessionId === s.id) {
          await startNewChat();
        }
      } catch (err) {
        console.warn('chat history delete failed', err);
      }
    }

    // Populate the empty-state "Recent chats" list from the gateway.
    // Best-effort: failures just leave the block hidden.
    let recentLoaded = false;
    async function loadRecentChats(): Promise<void> {
      if (recentLoaded) return;
      recentLoaded = true;
      try {
        const sessions = (await listConversations(appId)).slice(0, 4);
        if (sessions.length === 0) return;
        recentList.innerHTML = '';
        const now = Date.now();
        for (const s of sessions) {
          recentList.append(
            el(
              'button',
              {
                class: 'app-chat-recent-row',
                type: 'button',
                onClick: () => {
                  void resumeSession(s);
                },
              },
              [
                el('span', { class: 'app-chat-recent-dot' }),
                el('span', { class: 'app-chat-recent-title' }, s.title || '(untitled chat)'),
                el('span', { class: 'app-chat-recent-meta' }, relativeTime(s.updatedAt, now)),
              ],
            ),
          );
        }
        recentBlock.hidden = false;
      } catch {
        /* swallow — recent list stays hidden */
      }
    }

    function appendError(text: string): void {
      empty.remove();
      const node = el('div', { class: 'app-chat-error' }, text);
      scroll.append(node);
      scroll.scrollTop = scroll.scrollHeight;
    }

    // ---------- ConversationMsg renderer ----------
    function renderRows(columns: string[], rows: Array<Record<string, unknown>>): HTMLElement {
      if (rows.length === 0) {
        return el('div', { class: 'app-chat-rows-empty' }, 'No rows.');
      }
      const table = el('table', { class: 'app-chat-rows' });
      const trh = el('tr');
      for (const c of columns) trh.append(el('th', {}, c));
      table.append(el('thead', {}, [trh]));
      const tbody = el('tbody');
      for (const r of rows.slice(0, 20)) {
        const tr = el('tr');
        for (const c of columns) tr.append(el('td', {}, formatCell(r[c])));
        tbody.append(tr);
      }
      table.append(tbody);
      return table;
    }

    function formatCell(v: unknown): string {
      if (v === null || v === undefined) return '';
      if (typeof v === 'string') return v;
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }

    function safeJson(v: unknown): string {
      try {
        return JSON.stringify(v ?? null);
      } catch {
        return String(v);
      }
    }

    // Tool results come back as a JSON string in `content[].text` (per the
    // pi-agent-core AgentToolResult shape). Try to recover the rows payload.
    function parseToolPayload(v: unknown): Record<string, unknown> | undefined {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        if ('columns' in obj && 'rows' in obj) return obj;
        if (Array.isArray(obj.content)) {
          const text = (obj.content as Array<{ type?: string; text?: string }>)
            .filter((c) => c?.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text!)
            .join('');
          if (text) {
            try {
              return JSON.parse(text) as Record<string, unknown>;
            } catch {
              return undefined;
            }
          }
        }
      }
      if (typeof v === 'string') {
        try {
          return JSON.parse(v) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
      return undefined;
    }

    function renderToolDetail(c: AppToolCall): HTMLElement {
      const wrap = el('div', { class: 'app-chat-tool-detail' });
      if (c.sql) {
        wrap.append(el('pre', { class: 'app-chat-tool-sql' }, c.sql));
      } else if (c.args !== undefined) {
        wrap.append(el('pre', { class: 'app-chat-tool-sql' }, safeJson(c.args)));
      }
      const result = el('div', { class: 'app-chat-tool-result' });
      if (c.state === 'running') {
        result.textContent = 'Running…';
      } else if (c.state === 'error') {
        result.classList.add('app-chat-tool-err');
        result.textContent = `Error: ${c.errorText ?? 'Tool failed.'}`;
      } else {
        const parsed = parseToolPayload(c.result);
        if (parsed && Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
          result.append(
            renderRows(parsed.columns as string[], parsed.rows as Array<Record<string, unknown>>),
          );
          if (parsed.truncated) {
            result.append(
              el(
                'div',
                { class: 'app-chat-rows-meta' },
                `Showing ${Math.min(20, (parsed.rows as unknown[]).length)} of ${parsed.totalRows ?? (parsed.rows as unknown[]).length} rows.`,
              ),
            );
          }
        } else if (c.result !== undefined) {
          result.textContent = safeJson(c.result);
        } else {
          result.textContent = '(no result)';
        }
      }
      wrap.append(result);
      return wrap;
    }

    function renderMessage(m: AppConversationMsg): HTMLElement {
      if (m.kind === 'user') {
        return el('div', { class: 'msg-user' }, [el('div', { class: 'msg-user-bubble' }, m.text)]);
      }
      if (m.kind === 'ai') {
        // Author chip + paragraph-split text, mirroring builder. The chip
        // uses the app's icon color so each app's chat reads as its own
        // surface, vs the generic "builder" chip.
        const author = el('div', { class: 'msg-ai-author' });
        author.innerHTML =
          `<span class="msg-ai-author-dot" style="background:${escapeHtml(app.color)}"></span>` +
          `<span class="msg-ai-author-name">${escapeHtml(app.name.toLowerCase())}</span>`;
        const para = el('div', { class: 'msg-ai-text' });
        const text = m.text || (m.streaming ? '…' : '');
        text.split('\n\n').forEach((p) => para.append(el('p', {}, p)));
        const cls = m.error ? 'msg-ai msg-ai-error' : 'msg-ai';
        return el('div', { class: cls }, [author, para]);
      }
      // toolGroup
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
      pill.innerHTML =
        `<span class="tg-bolt">${BoltSvg(13)}</span>` +
        `<span class="tg-label">${escapeHtml(summarizeGroup(m.calls))}</span>` +
        `<span class="tg-chev">${ChevSvg(13)}</span>`;
      pill.addEventListener('click', () => {
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
          const expand = el('span', {
            class: 'tg-row-expand',
            trustedHtml: ChevSvg(11),
          });
          const row = el(
            'button',
            {
              type: 'button',
              class: 'tg-row tg-row-clickable',
              'data-state': c.state,
              'data-open': String(!!c.open),
              onClick: () => {
                chat = chat.map((x) => {
                  if (x.kind !== 'toolGroup' || x.id !== groupId) return x;
                  return {
                    ...x,
                    calls: x.calls.map((cc) => (cc.id === c.id ? { ...cc, open: !cc.open } : cc)),
                  };
                });
                renderChat();
              },
            },
            [dot, name, target, expand],
          );
          list.append(row);
          if (c.open) list.append(renderToolDetail(c));
        }
        wrap.append(list);
      }
      return wrap;
    }

    function renderChat(): void {
      // Sticky-bottom: only pin to the bottom if the user was already at
      // (or within a few px of) the bottom before this re-render. Otherwise
      // restore their prior scrollTop so toggling a tool-call expander or
      // any other in-place rerender doesn't yank them down while they're
      // reading earlier content.
      const prevScrollTop = scroll.scrollTop;
      const wasAtBottom = prevScrollTop + scroll.clientHeight >= scroll.scrollHeight - 8;
      scroll.innerHTML = '';
      if (chat.length === 0) {
        scroll.append(empty);
      } else {
        chat.forEach((m) => scroll.append(renderMessage(m)));
      }
      // Centered "Thinking…" pill while the agent is between user prompt and
      // first assistant content. Mirrors builder's gen-row.
      if (activeTurn !== null) {
        const state = turnState.get(activeTurn);
        if (state && !state.hadContent) {
          scroll.append(
            el('div', { class: 'gen-row' }, [
              el('span', { class: 'msg-status' }, [el('span', { class: 'pulse' }), ' Thinking…']),
            ]),
          );
        }
      }
      scroll.scrollTop = wasAtBottom ? scroll.scrollHeight : prevScrollTop;
    }

    // ---------- ConversationMsg mutators ----------
    function ensureTurnState(turnId: number): {
      streamed: string;
      hadDelta: boolean;
      hadContent: boolean;
      aiIndex: number;
    } {
      const existing = turnState.get(turnId);
      if (existing) return existing;
      const next = { streamed: '', hadDelta: false, hadContent: false, aiIndex: -1 };
      turnState.set(turnId, next);
      return next;
    }

    function pushAi(text: string, streaming: boolean): number {
      chat = chat.concat([{ kind: 'ai', text, streaming }]);
      return chat.length - 1;
    }

    function patchAi(
      idx: number,
      patch: Partial<Extract<AppConversationMsg, { kind: 'ai' }>>,
    ): void {
      chat = chat.map((m, i) => (i === idx && m.kind === 'ai' ? { ...m, ...patch } : m));
    }

    function appendOrStartToolCall(call: AppToolCall): void {
      const lastIdx = chat.length - 1;
      const last = chat[lastIdx];
      if (last && last.kind === 'toolGroup') {
        const updated: AppConversationMsg = { ...last, calls: [...last.calls, call] };
        chat = chat.map((m, i) => (i === lastIdx ? updated : m));
      } else {
        chat = chat.concat([{ kind: 'toolGroup', id: call.id, calls: [call], open: true }]);
      }
    }

    function patchToolCall(callId: string, patch: Partial<AppToolCall>): void {
      chat = chat.map((m) => {
        if (m.kind !== 'toolGroup') return m;
        if (!m.calls.some((c) => c.id === callId)) return m;
        return {
          ...m,
          calls: m.calls.map((c) => (c.id === callId ? { ...c, ...patch } : c)),
        };
      });
    }

    /** Mark a turn done if it's still the active one (idempotent — fired by
     *  the terminal stream event and again when streamTurn() resolves). */
    function finishTurn(turnId: number): void {
      if (activeTurn === turnId) {
        activeTurn = null;
        setBusy(false);
      }
    }

    /** Surface minted webhook secrets once, as an assistant message — the
     *  plaintext secret is never persisted, so this is the only place to
     *  capture it. */
    function announceWebhooks(
      minted: Array<{ automationId: string; url: string; secret: string }>,
    ): void {
      for (const w of minted) {
        chat = chat.concat([
          {
            kind: 'ai',
            text: `Webhook created for ${w.automationId}.\nURL: ${w.url}\nSecret (shown once — copy it now): ${w.secret}`,
          },
        ]);
      }
    }

    /**
     * Consume the gateway's native `TurnStreamEvent` union (issue #141,
     * Phase 3 — no IPC translation layer). Tool calls now carry a real
     * `toolCallId`, so the renderer targets results directly instead of
     * minting its own ids.
     */
    function handleStreamEvent(turnId: number, event: TurnStreamEvent): void {
      const state = ensureTurnState(turnId);
      switch (event.type) {
        case 'assistant.start':
        case 'reasoning.delta':
        case 'phase':
        case 'usage':
          return;
        case 'assistant.delta':
          state.hadDelta = true;
          state.hadContent = true;
          state.streamed += event.delta;
          if (state.aiIndex < 0) state.aiIndex = pushAi(state.streamed, true);
          else patchAi(state.aiIndex, { text: state.streamed, streaming: true });
          renderChat();
          return;
        case 'tool.start':
          state.hadContent = true;
          // A tool call after streamed AI text closes the bubble so later
          // deltas don't reattach to it.
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false });
            state.aiIndex = -1;
          }
          appendOrStartToolCall({
            id: event.toolCallId,
            tool: event.toolName,
            sql: event.sql,
            args: event.args,
            summary: summarizeToolArgs(event.sql, event.args),
            state: 'running',
          });
          renderChat();
          return;
        case 'tool.result':
          patchToolCall(
            event.toolCallId,
            event.ok
              ? { state: 'ok', result: event.result }
              : { state: 'error', errorText: event.errorText ?? 'Tool failed.' },
          );
          renderChat();
          return;
        case 'webhooks':
          announceWebhooks(event.minted);
          renderChat();
          return;
        case 'final':
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false });
          } else if (event.text) {
            state.aiIndex = pushAi(event.text, false);
            state.hadContent = true;
          }
          finishTurn(turnId);
          renderChat();
          return;
        case 'error': {
          const msg = event.message || 'Something went wrong.';
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false, error: true, text: msg });
          } else {
            state.aiIndex = pushAi(msg, false);
            patchAi(state.aiIndex, { error: true });
            state.hadContent = true;
          }
          finishTurn(turnId);
          renderChat();
          return;
        }
        case 'aborted':
          if (state.aiIndex >= 0) {
            patchAi(state.aiIndex, { streaming: false });
          } else {
            state.aiIndex = pushAi('(stopped)', false);
            state.hadContent = true;
          }
          finishTurn(turnId);
          renderChat();
      }
    }

    function setBusy(busy: boolean): void {
      sendBtn.hidden = busy;
      stopBtn.hidden = !busy;
      sendBtn.disabled = busy;
    }

    /** First-message title: whitespace-collapsed + truncated (the store used
     *  to derive this server-side; we do it client-side now). */
    function deriveTitle(text: string): string {
      return text.replace(/\s+/g, ' ').trim().slice(0, 60);
    }

    /**
     * Resolve the model id to send for the gateway's currently-active runner.
     * The selection is stored per-runner (`chatModelByRunner`) so it can never
     * carry across an agent switch. When the composer pill has loaded we use
     * its cached (optimistically-updated) selection — that avoids racing a
     * just-saved choice against a fresh `getSettings` read. Otherwise we read
     * settings + the `agent.runner.kind` pref directly. `undefined` → let the
     * gateway pick its default.
     */
    async function resolveChatModelForActiveRunner(): Promise<string | undefined> {
      if (amLoaded) {
        const saved = amSelByRunner[amActiveRunner];
        if (!saved) return undefined;
        // Don't send a model the active runner no longer offers — that's the
        // "unavailable · won't be sent" state the pill shows. Only suppress
        // when we actually have a catalog to check against; if enumeration
        // failed (empty list) send it anyway rather than silently dropping it.
        if (amModels.length && !amModels.some((m) => m.id === saved)) return undefined;
        return saved;
      }
      const [settings, prefs] = await Promise.all([
        window.CentraidApi.getSettings(),
        getUserPrefs().catch(() => ({}) as Record<string, unknown>),
      ]);
      const kindRaw = prefs['agent.runner.kind'];
      const kind = typeof kindRaw === 'string' && kindRaw ? kindRaw : 'codex';
      return settings.chatModelByRunner?.[kind];
    }

    async function submit(): Promise<void> {
      const text = input.value.trim();
      if (!text || activeTurn !== null) return;
      const turnId = nextTurnId++;
      activeTurn = turnId;
      input.value = '';
      autosize();
      setBusy(true);
      empty.remove();
      chat = chat.concat([{ kind: 'user', text }]);
      ensureTurnState(turnId);
      renderChat();
      try {
        // Lazily create the session row on first send — its id is the
        // chat session id the gateway keys the turn (+ transcript) on.
        if (!currentSessionId) {
          const created = await createConversation(appId, deriveTitle(text));
          currentSessionId = created.id;
          setHeadContext(created.title || null);
        }
        const model = await resolveChatModelForActiveRunner();
        abortController = new AbortController();
        await streamTurn(
          appId,
          {
            conversationId: currentSessionId,
            message: text,
            // The copilot is the ASK register (issue #286 phase 2): the
            // gateway routes vault-backed apps onto the vault tools. The
            // builder pane sends no register and keeps the unified runner.
            register: 'ask',
            ...(model ? { model } : {}),
            ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
          },
          (evt) => handleStreamEvent(turnId, evt),
          abortController.signal,
        );
        pendingAttachments = [];
        renderAttachChips();
        // Stream ended; finalize in case it closed without a terminal event.
        finishTurn(turnId);
        renderChat();
      } catch (err) {
        if (abortController?.signal.aborted) {
          handleStreamEvent(turnId, { type: 'aborted' });
          return;
        }
        const state = ensureTurnState(turnId);
        const msg = `Send failed: ${String(err)}`;
        if (state.aiIndex >= 0) {
          patchAi(state.aiIndex, { text: msg, error: true, streaming: false });
        } else {
          state.aiIndex = pushAi(msg, false);
          patchAi(state.aiIndex, { error: true });
          state.hadContent = true;
        }
        finishTurn(turnId);
        renderChat();
      }
    }

    function autosize(): void {
      input.style.height = 'auto';
      input.style.height = `${Math.min(140, input.scrollHeight)}px`;
    }
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    });

    return () => {
      try {
        if (activeTurn !== null) abortController?.abort();
      } catch {
        /* swallow */
      }
      document.removeEventListener('keydown', onGlobalKey);
      document.removeEventListener('click', onAmDocClick);
      document.removeEventListener('keydown', onAmEsc);
      fab.remove();
      panel.remove();
    };
  }

  window.AppChat = { mount };
})();
