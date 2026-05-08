// Builder mode — chat-driven app generation, wired live to:
//   - the centraid agent (window.CentraidApi.startAgent / promptAgent / onAgentEvent)
//   - the project folder on disk (readProjectFiles for the Code tab)
//   - the openclaw centraid plugin (publish, listVersions, activateVersion)
//
// Three tabs on the right pane: Preview / Code / History.
//   Preview: iframe → <gatewayUrl>/centraid/<id>/  after first publish.
//   Code:    real files from <projectsDir>/<id>/, syntax-highlighted.
//   History: real version list from the gateway, with restore.

(function () {
  type ChatMsg =
    | { kind: 'divider'; text: string }
    | { kind: 'status'; text: string; spinning?: boolean }
    | { kind: 'user'; text: string }
    | { kind: 'ai'; text: string; streaming?: boolean }
    | { kind: 'thinking'; text: string; streaming?: boolean }
    | {
        kind: 'tool';
        tool: string;
        summary?: string;
        state: 'running' | 'ok' | 'error';
      };

  type Tab = 'preview' | 'code' | 'history';
  type DeviceKey = 'mobile' | 'desktop';

  const Api = (): Window['CentraidApi'] => window.CentraidApi;

  function escapeHtml(s: string): string {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function tokenize(src: string, lang: 'html' | 'js' | 'ts' | 'css' | 'json' | 'md' | 'other'): string {
    let html = escapeHtml(src);
    if (lang === 'html') {
      html = html
        .replaceAll(/(&lt;\/?[\w-]+)/g, '<span class="tok-tag">$1</span>')
        .replaceAll(/(\s[\w-]+)=/g, '<span class="tok-attr">$1</span>=')
        .replaceAll(/("[^"]*")/g, '<span class="tok-str">$1</span>');
    } else if (lang === 'js' || lang === 'ts') {
      html = html
        .replaceAll(/\/\/[^\n]*/g, (m) => `<span class="tok-com">${m}</span>`)
        .replaceAll(
          /\b(const|let|var|function|return|if|else|for|new|try|catch|throw|async|await|export|import|from|type|interface|class|extends|implements|satisfies)\b/g,
          '<span class="tok-key">$1</span>',
        )
        .replaceAll(/('[^']*'|"[^"]*"|`[^`]*`)/g, '<span class="tok-str">$1</span>');
    } else if (lang === 'css') {
      html = html
        .replaceAll(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-com">$1</span>')
        .replaceAll(/(--[\w-]+)/g, '<span class="tok-key">$1</span>')
        .replaceAll(/(#[0-9a-f]{3,8}|\d+px|\d+%)/g, '<span class="tok-str">$1</span>');
    } else if (lang === 'json') {
      html = html
        .replaceAll(/("[^"]*")(\s*:)/g, '<span class="tok-attr">$1</span>$2')
        .replaceAll(/:\s*("[^"]*")/g, ': <span class="tok-str">$1</span>')
        .replaceAll(/\b(true|false|null)\b/g, '<span class="tok-key">$1</span>');
    }
    return html;
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
    let previewDevice: DeviceKey = 'mobile';
    let generating = false;
    let publishing = false;
    let lastPublishedVersionId: string | undefined;
    let resizeHandler: (() => void) | null = null;
    let unsubscribeAgent: (() => void) | null = null;
    let liveUrl: string | undefined;
    let currentAiMsgIndex = -1; // index in `chat` of the streaming AI bubble
    let currentThinkingMsgIndex = -1; // index of the streaming thinking block
    let pendingToolStarts = new Map<string, number>(); // toolCallId → chat index
    // Set by tool_execution_end when the agent writes/edits a file in the
    // project. Consumed by turn_end to refresh the preview iframe so the
    // user sees their changes without manually reloading.
    let previewReloadPending = false;
    const FILE_WRITING_TOOLS = new Set(['write', 'edit', 'multi_edit']);

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

    const tabDefs: [Tab, string, IconNameType][] = [
      ['preview', 'Preview', 'Eye'],
      ['code', 'Code', 'Code'],
      ['history', 'History', 'History'],
    ];

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
      el(
        'div',
        { class: 'mode-tabs' },
        tabDefs.map(([key, label, iconKey]) => {
          const btn = el('button', {
            class: 'mode-tab',
            'data-active': String(tab === key),
            onClick: () => {
              tab = key;
              renderRight();
              refreshTabs();
            },
          });
          btn.innerHTML = `${Icon[iconKey]({ size: 13 })}<span>${label}</span>`;
          return btn;
        }),
      ),
      el('div', { class: 'builder-topbar-right' }, [
        el('button', { class: 'btn btn-ghost' }, 'Share'),
        primaryBtn,
      ]),
    ]);

    function refreshTabs(): void {
      topbar.querySelectorAll('.mode-tab').forEach((b, i) => {
        const keys: Tab[] = ['preview', 'code', 'history'];
        (b as HTMLElement).dataset.active = String(tab === keys[i]);
      });
    }

    function setSubtitle(text: string): void {
      projSubtitleEl.textContent = text;
    }

    function showToast(text: string): void {
      const existing = body.querySelector('.preview-toast');
      if (existing) existing.remove();
      const toast = el('div', {
        class: 'preview-toast',
        trustedHtml: Icon.Check({ size: 13, strokeWidth: 2.5 }) + ` <span>${escapeHtml(text)}</span>`,
      });
      body.append(toast);
      setTimeout(() => toast.remove(), 2400);
    }

    function showActionToast(text: string, actionLabel: string, onAction: () => void): void {
      const existing = body.querySelector('.preview-toast');
      if (existing) existing.remove();
      const toast = el('div', { class: 'preview-toast preview-toast-action' });
      const iconHost = el('span', { trustedHtml: Icon.X ? Icon.X({ size: 13, strokeWidth: 2.5 }) : '!' });
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
    const body = el('div', { class: 'builder-body' });
    const chatPane = el('div', { class: 'chat-pane' });
    const rightPane = el('div', { class: 'right-pane' });
    body.append(chatPane);
    body.append(rightPane);

    const chatScroll = el('div', { class: 'chat-scroll' });
    const inputWrap = el('div', { class: 'chat-input-wrap' });
    chatPane.append(chatScroll);
    chatPane.append(inputWrap);

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
      if (m.kind === 'tool') {
        const stateIcon =
          m.state === 'running'
            ? el('span', { class: 'tool-spinner' })
            : m.state === 'error'
              ? el('span', {
                  class: 'tool-icon tool-icon-err',
                  trustedHtml: Icon.X ? Icon.X({ size: 11, strokeWidth: 2.5 }) : '✗',
                })
              : el('span', {
                  class: 'tool-icon tool-icon-ok',
                  trustedHtml: Icon.Check({ size: 11, strokeWidth: 2.5 }),
                });
        const children: HTMLElement[] = [
          stateIcon,
          el('span', { class: 'tool-name' }, m.tool),
        ];
        if (m.summary) {
          children.push(el('span', { class: 'tool-arg' }, m.summary));
        }
        return el('div', { class: 'chat-tool-row', 'data-state': m.state }, children);
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

    // ---------- Right pane ----------
    function renderRight(): void {
      rightPane.innerHTML = '';
      rightPane.classList.remove('preview-pane', 'has-phone');
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
      }
      if (tab === 'preview') void renderPreview();
      else if (tab === 'code') void renderCode();
      else void renderHistory();
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

      const toggle = el(
        'div',
        { class: 'preview-device-toggle' },
        (
          [
            ['mobile', 'Mobile'],
            ['desktop', 'Desktop'],
          ] as [DeviceKey, string][]
        ).map(([key, label]) =>
          el(
            'button',
            {
              'data-active': String(previewDevice === key),
              onClick: () => {
                previewDevice = key;
                renderRight();
              },
            },
            label,
          ),
        ),
      );
      rightPane.append(toggle);

      const resolved = projectId ? await resolvePreviewSrc() : undefined;

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

      const sourceLabel = el(
        'div',
        { class: 'preview-source-label', 'data-kind': resolved.kind },
        resolved.kind === 'live' ? 'Preview · live' : 'Preview · local files',
      );
      rightPane.append(sourceLabel);

      if (previewDevice === 'desktop') {
        const stage = el('div', { class: 'preview-stage' });
        const card = el('div', { class: 'preview-card' });
        card.style.setProperty('--accent-color', projColor as string);
        card.append(makePreviewFrame(resolved.src));
        stage.append(card);
        rightPane.append(stage);
        return;
      }

      const scaler = el('div', { class: 'phone-scale' });
      const phone = el('div', { class: 'phone' });
      const notch = el('div', { class: 'phone-notch' });
      const indicator = el('div', { class: 'phone-indicator' });
      const screen = el('div', { class: 'phone-screen' });
      const statusBar = el('div', { class: 'status-bar' });
      statusBar.innerHTML =
        `<span>9:41</span>` +
        `<span class="status-right">${Icon.Cellular({ size: 15 })}${Icon.Wifi({ size: 15 })}${Icon.Battery({ size: 20 })}</span>`;
      const content = el('div', { class: 'phone-content' });
      content.style.setProperty('--accent-color', projColor as string);
      screen.append(statusBar);
      screen.append(content);
      phone.append(notch);
      phone.append(screen);
      phone.append(indicator);
      scaler.append(phone);
      rightPane.append(scaler);

      content.append(makePreviewFrame(resolved.src));

      const fit = (): void => {
        const r = rightPane.getBoundingClientRect();
        const pad = 64;
        const availW = r.width - pad;
        const availH = r.height - pad;
        if (availW <= 0 || availH <= 0) return;
        const s = Math.min(1, availW / 390, availH / 720);
        scaler.style.transform = `scale(${s})`;
      };
      fit();
      resizeHandler = fit;
      window.addEventListener('resize', resizeHandler);
    }

    async function renderCode(): Promise<void> {
      const tabsRow = el('div', { class: 'code-tabs' });
      const codeBody = el('div', { class: 'code-body' });
      rightPane.append(tabsRow);
      rightPane.append(codeBody);

      if (!projectId) {
        codeBody.innerHTML = '<div class="empty">No project yet.</div>';
        return;
      }

      let files: Awaited<ReturnType<Window['CentraidApi']['readProjectFiles']>> = [];
      try {
        files = await Api().readProjectFiles({ id: projectId });
      } catch (err) {
        codeBody.innerHTML = `<div class="empty">Could not read files: ${escapeHtml(String(err))}</div>`;
        return;
      }

      if (files.length === 0) {
        codeBody.innerHTML = '<div class="empty">Empty project.</div>';
        return;
      }

      // Sensible default: prefer index.html if present, else first file.
      let active = files.find((f) => f.path === 'index.html')?.path ?? files[0]!.path;

      const drawCode = (): void => {
        codeBody.innerHTML = '';
        const file = files.find((f) => f.path === active);
        if (!file) {
          codeBody.innerHTML = '<div class="empty">File not found.</div>';
          return;
        }
        const lines = file.content.split('\n');
        const gutter = el('div', { class: 'code-gutter' });
        lines.forEach((_, i) => gutter.append(el('div', {}, String(i + 1))));
        const text = el('pre', { class: 'code-text' });
        text.innerHTML = tokenize(file.content, languageHint(file.path));
        codeBody.append(gutter);
        codeBody.append(text);
      };

      const drawTabs = (): void => {
        tabsRow.innerHTML = '';
        for (const f of files) {
          tabsRow.append(
            el(
              'button',
              {
                class: 'code-tab',
                'data-active': String(active === f.path),
                onClick: () => {
                  active = f.path;
                  drawTabs();
                  drawCode();
                },
              },
              f.path,
            ),
          );
        }
        const meta = el(
          'div',
          { class: 'code-meta' },
          `${files.length} files · read-only`,
        );
        tabsRow.append(meta);
      };

      drawTabs();
      drawCode();
    }

    async function renderHistory(): Promise<void> {
      const list = el('div', { class: 'history-list' });
      rightPane.append(list);

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

      const sorted = [...result.versions].sort((a, b) =>
        b.uploadedAt.localeCompare(a.uploadedAt),
      );

      const draw = (): void => {
        list.innerHTML = '';
        for (const v of sorted) {
          const isCurrent = v.versionId === result.activeVersion;
          const item = el(
            'div',
            { class: 'history-item', 'data-active': String(isCurrent) },
            [
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
                              if (tab === 'history') renderRight();
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
            ],
          );
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
      const toolIdxByCallId = new Map<string, number>();
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
              const summary = summarizeToolArgs(tc.name, tc.arguments);
              const idx = out.length;
              out.push({ kind: 'tool', tool: tc.name, summary, state: 'ok' });
              toolIdxByCallId.set(tc.id, idx);
            }
          }
          flushText();
          flushThink();
          continue;
        }
        if (m.role === 'toolResult') {
          const tr = m as { toolCallId: string; isError: boolean };
          const idx = toolIdxByCallId.get(tr.toolCallId);
          if (idx !== undefined) {
            const cur = out[idx];
            if (cur && cur.kind === 'tool') {
              out[idx] = { ...cur, state: tr.isError ? 'error' : 'ok' };
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
          const summary = summarizeToolArgs(event.toolName, event.args);
          const idx = pushMessage({
            kind: 'tool',
            tool: event.toolName,
            summary,
            state: 'running',
          });
          pendingToolStarts.set(event.toolCallId, idx);
          break;
        }
        case 'tool_execution_end': {
          const idx = pendingToolStarts.get(event.toolCallId);
          pendingToolStarts.delete(event.toolCallId);
          if (idx !== undefined) {
            const prev = chat[idx];
            const summary = prev && prev.kind === 'tool' ? prev.summary : undefined;
            updateMessage(idx, {
              kind: 'tool',
              tool: event.toolName,
              summary,
              state: event.isError ? 'error' : 'ok',
            });
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
        updateMessage(statusIdx, {
          kind: 'status',
          text: `Published ${shortVersionTitle(result)} (${result.files} files, ${(result.bytes / 1024).toFixed(1)} KB)`,
        });
        showToast(`Published ${shortVersionTitle(result)}`);
        if (tab === 'history') renderRight();
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
        } else if (/gateway_unreachable|Could not reach gateway|fetch failed|ECONNREFUSED/i.test(msg)) {
          updateMessage(statusIdx, {
            kind: 'status',
            text: 'Gateway not reachable. Is openclaw running?',
          });
          showActionToast(
            'Gateway not reachable. Check the URL in Settings.',
            'Open Settings',
            () => void window.Centraid?.openSettings?.(),
          );
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

    renderChat();
    renderInput();
    renderRight();

    // Kick off async setup.
    void bootstrap();

    // Cleanup
    return () => {
      if (unsubscribeAgent) {
        unsubscribeAgent();
        unsubscribeAgent = null;
      }
      void Api().stopAgent().catch(() => undefined);
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    };
  }

  window.openBuilder = openBuilder;
})();
