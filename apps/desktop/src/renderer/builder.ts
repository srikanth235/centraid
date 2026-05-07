// Builder mode — chat-driven app generation, mocked.
// Three tabs on the right pane: Preview / Code / History.
// All chat replies are canned. The "preview" renders the actual Habits
// app inline (re-using its mount fn) so you can see something real moving.

(function () {
  type ChatMsg =
    | { kind: 'divider'; text: string }
    | { kind: 'status'; text: string }
    | { kind: 'user'; text: string }
    | { kind: 'ai'; text: string };

  interface VersionEntry {
    id: number;
    title: string;
    prompt: string;
    when: string;
    current?: boolean;
  }

  type Tab = 'preview' | 'code' | 'history';
  type DeviceKey = 'mobile' | 'desktop';

  const SAMPLE_CHAT: ChatMsg[] = [
    { kind: 'divider', text: 'Today' },
    {
      kind: 'user',
      text: 'Make a habit tracker. I want to mark each habit done by tapping a circle, with a streak counter. Soft, calm, dark interface.',
    },
    {
      kind: 'ai',
      text: "Here's a calm habit tracker. Each row has a habit name, current streak, and a tap-to-complete circle that animates as it fills. The dark surface uses warm tones so it doesn't feel clinical at night.\n\nHabits persist locally. Tapping the same circle twice in a day won't double-count.",
    },
    { kind: 'user', text: 'Can you add a weekly view? I want to see the last 7 days at a glance.' },
    {
      kind: 'ai',
      text: "Added a 7-dot row under each habit showing the past week — filled if completed, hollow if not. Today's dot has a thin ring so you can spot it. The streak counter now reflects the longest current run rather than total completions.",
    },
    { kind: 'status', text: 'Saved as Version 3' },
    {
      kind: 'user',
      text: 'Make the dots a bit bigger and add a small check inside completed ones.',
    },
    {
      kind: 'ai',
      text: "Bumped the dots from 8px to 12px and added a small check glyph in completed ones (currentColor at 60% opacity so it doesn't fight the fill).\n\nLet me know if you want the check icon at a different weight.",
    },
  ];

  const SAMPLE_VERSIONS: VersionEntry[] = [
    {
      current: true,
      id: 4,
      prompt: 'Make the dots a bit bigger and add a small check inside completed ones.',
      title: 'Bigger dots, check glyphs',
      when: 'Just now',
    },
    {
      id: 3,
      prompt: 'Can you add a weekly view? I want to see the last 7 days at a glance.',
      title: 'Weekly view added',
      when: '4 minutes ago',
    },
    {
      id: 2,
      prompt: 'Make a habit tracker. I want to mark each habit done by tapping a circle…',
      title: 'First habit tracker',
      when: '11 minutes ago',
    },
    {
      id: 1,
      prompt: '(automatic) project initialized',
      title: 'Initial scaffold',
      when: '12 minutes ago',
    },
  ];

  const CODE_FILES: Record<string, string> = {
    'app.js': `// Habit tracker — persists to localStorage.
const STORAGE = 'centraid.habits';
const today = () => new Date().toISOString().slice(0, 10);

function load() {
  try { return JSON.parse(localStorage.getItem(STORAGE)) || seed(); }
  catch { return seed(); }
}
function seed() {
  return [
    { name: 'Read 20 pages',   log: [] },
    { name: 'Walk 30 min',     log: [] },
    { name: 'No phone in bed', log: [] },
  ];
}
function save(habits) { localStorage.setItem(STORAGE, JSON.stringify(habits)); }

function streakOf(habit) {
  let s = 0;
  for (let i = 0; i < 365; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    if (habit.log.includes(k)) s++; else break;
  }
  return s;
}

function render() { /* … */ }
render();`,
    'index.html': `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Habits</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main id="root"></main>
    <script src="app.js"></script>
  </body>
</html>`,
    'styles.css': `:root {
  --bg: #fbfaf6;
  --ink: #1c1812;
  --accent: #5847e0;
  --line: rgba(28, 24, 18, .08);
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: 'Inter', system-ui;
}
.habit-row {
  background: white;
  border: .5px solid var(--line);
  border-radius: 14px;
  padding: 12px 14px;
  display: flex;
  gap: 12px;
}`,
  };

  const CANNED_REPLIES = [
    'Got it — updated the layout and saved a new version.',
    'Tightened spacing between rows and bumped the corner radius from 12 to 14 to match the rest of the surface.',
    'Swapped to a softer accent. The previous one fought the warm background a little.',
    "Added subtle motion on tap so completing a row feels deliberate. I kept it under 200ms so it doesn't get in the way.",
    'Reorganized the controls — primary action on the right, destructive ones tucked behind the kebab.',
  ];

  function escapeHtml(s: string): string {
    return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
  function tokenize(src: string, lang: 'html' | 'js' | 'css'): string {
    let html = escapeHtml(src);
    if (lang === 'html') {
      html = html
        .replaceAll(/(&lt;\/?[\w-]+)/g, '<span class="tok-tag">$1</span>')
        .replaceAll(/(\s[\w-]+)=/g, '<span class="tok-attr">$1</span>=')
        .replaceAll(/("[^"]*")/g, '<span class="tok-str">$1</span>');
    } else if (lang === 'js') {
      html = html
        .replaceAll(/\/\/[^\n]*/g, (m) => `<span class="tok-com">${m}</span>`)
        .replaceAll(
          /\b(const|let|function|return|if|else|for|new|try|catch|throw)\b/g,
          '<span class="tok-key">$1</span>',
        )
        .replaceAll(/('[^']*'|"[^"]*"|`[^`]*`)/g, '<span class="tok-str">$1</span>');
    } else if (lang === 'css') {
      html = html
        .replaceAll(/(\/\*[\s\S]*?\*\/)/g, '<span class="tok-com">$1</span>')
        .replaceAll(/(--[\w-]+)/g, '<span class="tok-key">$1</span>')
        .replaceAll(/(#[0-9a-f]{3,8}|\d+px|\d+%)/g, '<span class="tok-str">$1</span>');
    }
    return html;
  }

  function openBuilder(opts: BuilderOptions): () => void {
    const { root, el, onExit, initialPrompt, appContext, onAddToHome } = opts;

    const isNewBuild = !!initialPrompt && !appContext;
    const isUpdateMode = !!appContext;
    const projName = appContext?.name || 'Habits';
    const projColor = appContext?.color || ICON_PALETTE.rose;
    const projIcon: IconNameType = appContext?.iconKey || 'Habit';

    let chat: ChatMsg[];
    if (isNewBuild) {
      chat = [
        { kind: 'divider', text: 'Today' },
        { kind: 'user', text: initialPrompt },
      ];
    } else if (isUpdateMode) {
      chat = [
        { kind: 'divider', text: 'Editing existing project' },
        { kind: 'ai', text: `Loaded "${projName}". What would you like to change?` },
      ];
    } else {
      chat = [...SAMPLE_CHAT];
    }
    let tab: Tab = 'preview';
    let previewDevice: DeviceKey = 'mobile';
    let generating = isNewBuild;
    let replyCounter = 0;
    let pendingTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeHandler: (() => void) | null = null;

    if (isNewBuild) {
      pendingTimer = setTimeout(() => {
        chat = chat.concat([
          {
            kind: 'ai',
            text: "Got the brief. Sketching the first version now — I'll start with a basic layout and you can iterate from there.",
          },
        ]);
        generating = false;
        renderChat();
      }, 1600);
    }

    const titlebar = el('div', { class: 'titlebar' }, [
      el('span', { class: 'wordmark', onClick: onExit, style: { cursor: 'pointer' } }, 'M'),
      el('span', { class: 'crumb', onClick: onExit, style: { cursor: 'pointer' } }, 'Centraid'),
      el('span', { class: 'crumb-sep' }, '/'),
      el('span', {}, isUpdateMode ? `Editing ${projName}` : 'Builder'),
    ]);

    const primaryBtn = el('button', { class: 'btn btn-primary' });
    if (isNewBuild) {
      primaryBtn.innerHTML = Icon.Plus({ size: 13 }) + '<span>Add to home</span>';
      primaryBtn.addEventListener('click', () => {
        if (typeof onAddToHome === 'function') {
          onAddToHome({ prompt: initialPrompt });
        }
      });
    } else {
      primaryBtn.innerHTML = (Icon.Save ? Icon.Save({ size: 13 }) : '') + '<span>Save</span>';
      primaryBtn.addEventListener('click', showSavedToast);
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

    const projSubtitle = isNewBuild
      ? 'Designing your new app'
      : isUpdateMode
        ? 'Editing existing app'
        : 'Previewing last saved version';

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
          onClick: onExit,
        }),
        projIconEl,
        el('div', { class: 'proj-name' }, [el('b', {}, projName), el('span', {}, projSubtitle)]),
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

    function showSavedToast(): void {
      const existing = body.querySelector('.preview-toast');
      if (existing) {
        existing.remove();
      }
      const toast = el('div', {
        class: 'preview-toast',
        trustedHtml:
          Icon.Check({ size: 13, strokeWidth: 2.5 }) + ' <span>Saved as Version 5</span>',
      });
      body.append(toast);
      setTimeout(() => toast.remove(), 1800);
    }

    const body = el('div', { class: 'builder-body' });
    const chatPane = el('div', { class: 'chat-pane' });
    const rightPane = el('div', { class: 'right-pane' });
    body.append(chatPane);
    body.append(rightPane);

    // ---- Chat pane ----
    const chatScroll = el('div', { class: 'chat-scroll' });
    const inputWrap = el('div', { class: 'chat-input-wrap' });
    chatPane.append(chatScroll);
    chatPane.append(inputWrap);

    function renderChat(): void {
      chatScroll.innerHTML = '';
      for (const m of chat) {
        chatScroll.append(renderMessage(m));
      }
      if (generating) {
        chatScroll.append(
          el('div', { class: 'gen-row' }, [
            el('span', { class: 'msg-status' }, [
              el('span', { class: 'pulse' }),
              ' Designing the layout…',
            ]),
          ]),
        );
      }
      chatScroll.scrollTop = chatScroll.scrollHeight;
    }

    function renderMessage(m: ChatMsg): HTMLElement {
      if (m.kind === 'divider') {
        return el('div', { class: 'chat-divider' }, [el('span', {}, m.text)]);
      }
      if (m.kind === 'status') {
        return el('div', { class: 'chat-status-row' }, [
          el('span', { class: 'msg-status' }, [
            el('span', { trustedHtml: Icon.Check({ size: 12, strokeWidth: 2.5 }) }),
            ' ' + m.text,
          ]),
        ]);
      }
      if (m.kind === 'user') {
        return el('div', { class: 'msg-user' }, [el('div', { class: 'msg-user-bubble' }, m.text)]);
      }
      const para = el('div', { class: 'msg-ai-text' });
      m.text.split('\n\n').forEach((p) => para.append(el('p', {}, p)));
      return el('div', { class: 'msg-ai' }, [para]);
    }

    function renderInput(): void {
      inputWrap.innerHTML = '';
      const hint = el('div', { class: 'hint-card' }, [
        el('span', { trustedHtml: Icon.Plus({ size: 13 }) }),
        ' Try a template from your other apps',
        el('a', { href: '#', onClick: (e: Event) => e.preventDefault() }, 'Browse'),
      ]);
      const ta = el('textarea', {
        placeholder: 'Ask, or describe what to change…',
        rows: 1,
      }) as HTMLTextAreaElement;
      const send = (): void => {
        const text = ta.value.trim();
        if (!text || generating) {
          return;
        }
        chat = chat.concat([{ kind: 'user', text }]);
        generating = true;
        ta.value = '';
        renderChat();
        if (pendingTimer) {
          clearTimeout(pendingTimer);
        }
        pendingTimer = setTimeout(() => {
          const reply = CANNED_REPLIES[replyCounter++ % CANNED_REPLIES.length] ?? '';
          chat = chat.concat([{ kind: 'ai', text: reply }]);
          generating = false;
          renderChat();
        }, 1400);
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
        el('button', { class: 'input-pill', title: 'Visual edits' }, 'Visual edits'),
        el('div', { class: 'spacer' }),
        el('button', { class: 'input-pill' }, 'Build ▾'),
        sendBtn,
      ]);
      const wrap = el('div', { class: 'chat-input' }, [ta, controls]);
      inputWrap.append(hint);
      inputWrap.append(wrap);
    }

    // ---- Right pane: Preview / Code / History ----
    function renderRight(): void {
      rightPane.innerHTML = '';
      rightPane.classList.remove('preview-pane', 'has-phone');
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
      }
      if (tab === 'preview') {
        renderPreview();
      } else if (tab === 'code') {
        renderCode();
      } else {
        renderHistory();
      }
    }

    function renderPreview(): void {
      rightPane.classList.add('preview-pane', 'has-phone');

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

      const previewApps = window.CentraidApps || {};
      const targetMount =
        (appContext && previewApps[appContext.id]?.mount) || previewApps.habits?.mount;

      if (previewDevice === 'desktop') {
        const stage = el('div', { class: 'preview-stage' });
        const card = el('div', { class: 'preview-card' });
        card.style.setProperty('--accent-color', projColor as string);
        stage.append(card);
        rightPane.append(stage);
        if (targetMount) {
          try {
            targetMount(card);
          } catch (error) {
            console.error(error);
            card.innerHTML = '<div class="empty">Preview failed.</div>';
          }
        } else {
          card.innerHTML = '<div class="empty">No preview available.</div>';
        }
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

      if (targetMount) {
        try {
          targetMount(content);
        } catch (error) {
          console.error(error);
          content.innerHTML = '<div class="empty">Preview failed.</div>';
        }
      } else {
        content.innerHTML = '<div class="empty">No preview available.</div>';
      }

      const fit = (): void => {
        const r = rightPane.getBoundingClientRect();
        const pad = 64;
        const availW = r.width - pad;
        const availH = r.height - pad;
        if (availW <= 0 || availH <= 0) {
          return;
        }
        const s = Math.min(1, availW / 390, availH / 720);
        scaler.style.transform = `scale(${s})`;
      };
      fit();
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
      }
      resizeHandler = fit;
      window.addEventListener('resize', resizeHandler);
    }

    function renderCode(): void {
      const tabsRow = el('div', { class: 'code-tabs' });
      const codeBody = el('div', { class: 'code-body' });
      let active = 'index.html';

      const drawCode = (): void => {
        codeBody.innerHTML = '';
        const lang: 'html' | 'js' | 'css' = active.endsWith('.html')
          ? 'html'
          : active.endsWith('.js')
            ? 'js'
            : 'css';
        const src = CODE_FILES[active] ?? '';
        const lines = src.split('\n');
        const gutter = el('div', { class: 'code-gutter' });
        lines.forEach((_, i) => gutter.append(el('div', {}, String(i + 1))));
        const text = el('pre', { class: 'code-text' });
        text.innerHTML = tokenize(src, lang);
        codeBody.append(gutter);
        codeBody.append(text);
      };

      const drawTabs = (): void => {
        tabsRow.innerHTML = '';
        Object.keys(CODE_FILES).forEach((name) => {
          tabsRow.append(
            el(
              'button',
              {
                class: 'code-tab',
                'data-active': String(active === name),
                onClick: () => {
                  active = name;
                  drawTabs();
                  drawCode();
                },
              },
              name,
            ),
          );
        });
        const meta = el('div', { class: 'code-meta' }, 'read-only · v4');
        tabsRow.append(meta);
      };

      drawTabs();
      drawCode();
      rightPane.append(tabsRow);
      rightPane.append(codeBody);
    }

    function renderHistory(): void {
      const list = el('div', { class: 'history-list' });
      let activeId: number | undefined = SAMPLE_VERSIONS.find((v) => v.current)?.id;
      const draw = (): void => {
        list.innerHTML = '';
        for (const v of SAMPLE_VERSIONS) {
          const item = el(
            'div',
            {
              class: 'history-item',
              'data-active': String(v.id === activeId),
              onClick: () => {
                activeId = v.id;
                draw();
              },
            },
            [
              el('div', { class: 'history-thumb' }, [el('div', { class: 'thumb-shimmer' })]),
              el('div', { class: 'history-meta' }, [
                el(
                  'div',
                  { class: 'history-title' },
                  [
                    el('b', {}, `v${v.id} · ${v.title}`),
                    v.current ? el('span', { class: 'current-tag' }, '● current') : null,
                  ].filter((x): x is HTMLElement => x !== null),
                ),
                el('div', { class: 'history-when' }, v.when),
                el('p', { class: 'history-prompt' }, v.prompt),
              ]),
              el(
                'div',
                { class: 'history-actions' },
                [
                  !v.current ? el('button', { class: 'btn btn-soft tiny-btn' }, 'Restore') : null,
                ].filter((x): x is HTMLElement => x !== null),
              ),
            ],
          );
          list.append(item);
        }
      };
      draw();
      rightPane.append(list);
    }

    // Mount everything
    root.append(titlebar);
    const builder = el('div', { class: 'builder' }, [topbar, body]);
    root.append(builder);

    renderChat();
    renderInput();
    renderRight();

    return () => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
      }
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
      }
    };
  }

  window.openBuilder = openBuilder;
})();
