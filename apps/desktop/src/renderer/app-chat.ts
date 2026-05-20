// governance: allow-repo-hygiene file-size-limit app-chat-widget pending split into mount / history-view / message-renderer modules
// App-scoped agentic chat widget. Floating button at the bottom-right of
// the app view; click opens a slide-out panel with multi-turn conversation.
// The agent runs in the desktop main process over openclaw WS and can only
// read/write this app's data.sqlite — see `apps/desktop/src/main/chat.ts`.
//
// Rendering mirrors the builder chat (apps/desktop/src/renderer/builder.ts):
// a typed `AppChatMsg[]` is fully re-rendered on every update, with adjacent
// tool calls folded into one collapsible "tool group" pill, an author chip
// on assistant turns, and a centered "Thinking…" status while the agent
// works. The in-app twist is that each tool row drills in to show the SQL
// and the result table inline. Past chats persist on the gateway and surface
// as a swappable history view inside the same panel.
//
// This module is loaded ahead of `app.js` and exposes `window.AppChat.mount`,
// which the shell calls from `mountUserApp`. Keeping it standalone caps the
// size of `app.ts` and makes the chat widget independently editable.

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
  type AppChatMsg =
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

    let started = false;
    let open = false;
    let nextTurnId = 1;
    let activeTurn: number | null = null;
    let unsubscribe: (() => void) | null = null;
    let chat: AppChatMsg[] = [];
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
      switch (tool) {
        case 'centraid_sql_read':
          return 'Querying';
        case 'centraid_sql_write':
          return 'Writing';
        case 'centraid_sql_describe':
          return 'Reading schema';
        default:
          return tool.charAt(0).toUpperCase() + tool.slice(1);
      }
    }

    function summarizeToolArgs(tool: string, sql?: string, args?: unknown): string | undefined {
      if ((tool === 'centraid_sql_read' || tool === 'centraid_sql_write') && sql) {
        const firstLine = sql.split('\n').find((l) => l.trim().length > 0) ?? sql;
        return firstLine.trim().replace(/\s+/g, ' ').slice(0, 90);
      }
      if (tool === 'centraid_sql_describe') return undefined;
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
    let historySessions: CentraidChatSessionMeta[] = [];
    let historyLoading = false;
    let historySearch = '';

    const Icon = window.Icon;

    // §D2 — ambient copilot FAB. Collapsed by default; carries a label
    // and a ⌘J hint so the entry point is legible, not just a glyph.
    const fab = el(
      'button',
      {
        class: 'app-chat-fab',
        type: 'button',
        title: 'Ask about this app',
        'aria-label': `Ask ${app.name}`,
      },
      [
        el('span', { class: 'app-chat-fab-icon', trustedHtml: Icon.Sparkle({ size: 16 }) }),
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
    const headTitle = el('div', { class: 'app-chat-title' }, [
      el('span', {
        class: 'app-chat-dot',
        style: { background: app.color },
      }),
      el('span', { class: 'app-chat-title-text' }, `Ask ${app.name}`),
    ]);
    const headCloseBtn = el('button', {
      class: 'app-chat-icon-btn app-chat-close',
      type: 'button',
      'aria-label': 'Close',
      title: 'Close',
      trustedHtml:
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
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
      headTitle,
      el('div', { class: 'app-chat-head-actions' }, [overflowWrap, headCloseBtn]),
    ]);
    // chat-scroll mirrors the builder; the panel-specific padding override
    // lives in styles.css under `.app-chat-panel .chat-scroll`.
    const scroll = el('div', { class: 'chat-scroll app-chat-scroll' });
    // §D1 — the empty state leads with "Try these starters": tappable
    // prompt chips that drop into the composer, so a fresh copilot pane
    // is never a blank box.
    const starterPrompts = [
      'What can this app do?',
      'Show me all the records',
      'Add a new entry',
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
    const empty = el('div', { class: 'app-chat-empty' }, [
      el('div', { class: 'app-chat-empty-title' }, `Chat with ${app.name}`),
      el(
        'div',
        { class: 'app-chat-empty-hint' },
        'Ask questions about this app’s data, or have the assistant add, update, or delete records on your behalf.',
      ),
      el('div', { class: 'app-chat-starters-label' }, 'Try these starters'),
      starterRow,
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
      trustedHtml: Icon.Send({ size: 14 }),
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
        void window.CentraidApi.chatAbort({ appId });
      },
    }) as HTMLButtonElement;
    const inputWrap = el('form', { class: 'app-chat-input-wrap' }, [input, sendBtn, stopBtn]);
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
        void ensureStarted();
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

    async function ensureStarted(): Promise<void> {
      if (started) return;
      started = true;
      unsubscribe = window.CentraidApi.onChatEvent((event) => {
        if (!event || event.appId !== appId) return;
        handleEvent(event);
      });
      try {
        await window.CentraidApi.chatStart({
          appId,
          appName: app.name,
          sessionId: currentSessionId,
        });
      } catch (err) {
        appendError(`Failed to start chat: ${String(err)}`);
        started = false;
      }
    }

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
        const res = await window.CentraidApi.chatHistoryList({ appId });
        historySessions = res.sessions ?? [];
      } catch (err) {
        historySessions = [];
        console.warn('chat history list failed', err);
      } finally {
        historyLoading = false;
        renderHistory();
      }
    }

    /**
     * Point the main-process ChatSession at a specific persisted chat (or
     * null for a brand-new one). The chat-event IPC subscription set up by
     * `ensureStarted()` stays alive for the panel's lifetime — calling
     * chatStart directly here avoids stacking duplicate listeners every time
     * the user switches chats. (Without this split, every assistant delta
     * gets dispatched once per past switch, producing "HeyHey Sri Sri" output.)
     */
    async function switchSession(sessionId: string | null): Promise<void> {
      try {
        await window.CentraidApi.chatStart({ appId, appName: app.name, sessionId });
      } catch (err) {
        appendError(`Failed to switch chat: ${String(err)}`);
      }
    }

    async function startNewChat(): Promise<void> {
      // If there's an inflight turn, cancel it before we discard the messages
      // so the gateway doesn't keep streaming into a now-orphaned conversation.
      if (activeTurn !== null) {
        try {
          await window.CentraidApi.chatAbort({ appId });
        } catch {
          /* swallow */
        }
        activeTurn = null;
        setBusy(false);
      }
      currentSessionId = null;
      chat = [];
      turnState.clear();
      lastToolIdByTurn.clear();
      headTitle.querySelector('.app-chat-title-text')!.textContent = `Ask ${app.name}`;
      await switchSession(null);
      setView('chat');
      renderChat();
      input.focus();
    }

    async function resumeSession(meta: CentraidChatSessionMeta): Promise<void> {
      if (activeTurn !== null) {
        try {
          await window.CentraidApi.chatAbort({ appId });
        } catch {
          /* swallow */
        }
        activeTurn = null;
        setBusy(false);
      }
      currentSessionId = meta.id;
      chat = [];
      turnState.clear();
      lastToolIdByTurn.clear();
      headTitle.querySelector('.app-chat-title-text')!.textContent =
        meta.title || `Ask ${app.name}`;
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
        const loaded = await window.CentraidApi.chatHistoryLoad({ sessionId: meta.id });
        chat = hydrateMessages(loaded.messages);
      } catch (err) {
        appendError(`Failed to load chat: ${String(err)}`);
        return;
      }
      await switchSession(meta.id);
      renderChat();
    }

    /**
     * Rebuild the renderer's `AppChatMsg[]` from the coarse-grained persisted
     * messages: consecutive `tool` rows fold into a single toolGroup so the
     * UI matches what the user saw live.
     */
    function hydrateMessages(
      rows: Array<{ idx: number; payload: CentraidChatHistoryMessage }>,
    ): AppChatMsg[] {
      const out: AppChatMsg[] = [];
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
            summary: summarizeToolArgs(payload.tool, payload.sql, payload.args),
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

    async function deleteSession(s: CentraidChatSessionMeta): Promise<void> {
      try {
        await window.CentraidApi.chatHistoryDelete({ sessionId: s.id });
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

    function appendError(text: string): void {
      empty.remove();
      const node = el('div', { class: 'app-chat-error' }, text);
      scroll.append(node);
      scroll.scrollTop = scroll.scrollHeight;
    }

    // ---------- ChatMsg renderer ----------
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

    function renderMessage(m: AppChatMsg): HTMLElement {
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

    // ---------- ChatMsg mutators ----------
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

    function patchAi(idx: number, patch: Partial<Extract<AppChatMsg, { kind: 'ai' }>>): void {
      chat = chat.map((m, i) => (i === idx && m.kind === 'ai' ? { ...m, ...patch } : m));
    }

    function appendOrStartToolCall(call: AppToolCall): void {
      const lastIdx = chat.length - 1;
      const last = chat[lastIdx];
      if (last && last.kind === 'toolGroup') {
        const updated: AppChatMsg = { ...last, calls: [...last.calls, call] };
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

    // The gateway streams tool events without explicit ids — phases just
    // arrive in order. We mint our own monotonic id per turn so the renderer
    // can target the correct call when the matching `tool-result`/`tool-error`
    // arrives.
    const lastToolIdByTurn = new Map<number, string>();
    let toolCounter = 0;
    function mintToolId(turnId: number): string {
      toolCounter += 1;
      const id = `t${turnId}-${toolCounter}`;
      lastToolIdByTurn.set(turnId, id);
      return id;
    }

    function handleEvent(event: CentraidChatEvent): void {
      const state = ensureTurnState(event.turnId);
      if (event.kind === 'thinking') {
        // Just keeps the centered "Thinking…" status visible; nothing to
        // patch on the chat array.
        renderChat();
        return;
      }
      if (event.kind === 'assistant-delta') {
        state.hadDelta = true;
        state.hadContent = true;
        state.streamed += event.delta;
        if (state.aiIndex < 0) {
          state.aiIndex = pushAi(state.streamed, true);
        } else {
          patchAi(state.aiIndex, { text: state.streamed, streaming: true });
        }
        renderChat();
        return;
      }
      if (event.kind === 'tool-call') {
        state.hadContent = true;
        // Tool call after AI text starts a new group; the streaming AI msg
        // is closed so subsequent deltas don't reattach to it (mirrors
        // builder's closeAi() on tool_execution_start).
        if (state.aiIndex >= 0) {
          patchAi(state.aiIndex, { streaming: false });
          state.aiIndex = -1;
        }
        const id = mintToolId(event.turnId);
        appendOrStartToolCall({
          id,
          tool: event.toolName,
          sql: event.sql,
          args: event.toolArgs,
          summary: summarizeToolArgs(event.toolName, event.sql, event.toolArgs),
          state: 'running',
        });
        renderChat();
        return;
      }
      if (event.kind === 'tool-result') {
        const id = lastToolIdByTurn.get(event.turnId);
        if (id) patchToolCall(id, { state: 'ok', result: event.toolResult });
        renderChat();
        return;
      }
      if (event.kind === 'tool-error') {
        const id = lastToolIdByTurn.get(event.turnId);
        if (id) patchToolCall(id, { state: 'error', errorText: event.text });
        renderChat();
        return;
      }
      if (event.kind === 'final') {
        if (state.aiIndex >= 0) {
          patchAi(state.aiIndex, { streaming: false });
        } else if (event.text) {
          state.aiIndex = pushAi(event.text, false);
          state.hadContent = true;
        }
        if (activeTurn === event.turnId) activeTurn = null;
        setBusy(false);
        renderChat();
        return;
      }
      if (event.kind === 'error') {
        if (state.aiIndex >= 0) {
          patchAi(state.aiIndex, {
            streaming: false,
            error: true,
            text: event.text || 'Something went wrong.',
          });
        } else {
          state.aiIndex = pushAi(event.text || 'Something went wrong.', false);
          patchAi(state.aiIndex, { error: true });
          state.hadContent = true;
        }
        if (activeTurn === event.turnId) activeTurn = null;
        setBusy(false);
        renderChat();
        return;
      }
      if (event.kind === 'aborted') {
        if (state.aiIndex >= 0) {
          patchAi(state.aiIndex, { streaming: false });
        } else {
          state.aiIndex = pushAi('(stopped)', false);
          state.hadContent = true;
        }
        if (activeTurn === event.turnId) activeTurn = null;
        setBusy(false);
        renderChat();
      }
    }

    function setBusy(busy: boolean): void {
      sendBtn.hidden = busy;
      stopBtn.hidden = !busy;
      sendBtn.disabled = busy;
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
      await ensureStarted();
      try {
        const settings = await window.CentraidApi.getSettings();
        const sendRes = await window.CentraidApi.chatSend({
          appId,
          text,
          turnId,
          model: settings.chatModel,
        });
        // Server is the single source of truth for sessionId AND title —
        // its `deriveTitle` collapses whitespace before truncating, so a
        // client-side `slice(0, 60)` would diverge for whitespace-heavy
        // first prompts. Take both straight from the response.
        currentSessionId = sendRes.sessionId;
        const titleEl = headTitle.querySelector('.app-chat-title-text');
        if (titleEl) {
          titleEl.textContent = sendRes.title || `Ask ${app.name}`;
        }
      } catch (err) {
        const state = ensureTurnState(turnId);
        const msg = `Send failed: ${String(err)}`;
        if (state.aiIndex >= 0) {
          patchAi(state.aiIndex, { text: msg, error: true, streaming: false });
        } else {
          state.aiIndex = pushAi(msg, false);
          patchAi(state.aiIndex, { error: true });
          state.hadContent = true;
        }
        activeTurn = null;
        setBusy(false);
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
        if (unsubscribe) unsubscribe();
        if (activeTurn !== null) void window.CentraidApi.chatAbort({ appId });
      } catch {
        /* swallow */
      }
      document.removeEventListener('keydown', onGlobalKey);
      fab.remove();
      panel.remove();
    };
  }

  window.AppChat = { mount };
})();
