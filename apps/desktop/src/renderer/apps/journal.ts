(function () {
  const STORAGE = 'journal.entries';
  type Entries = Record<string, string>;

  function mount(root: HTMLElement): void {
    const entries = Store.get<Entries>(STORAGE, {});
    let activeDate = DateUtil.todayKey();
    if (!(activeDate in entries)) {
      entries[activeDate] = '';
    }

    const persist = (): void => Store.set(STORAGE, entries);
    const { el } = window.Centraid;

    function render(): void {
      root.innerHTML = '';
      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Journal'),
          el('p', { class: 'app-subtitle' }, 'A clean place to write each day.'),
        ]),
        el('button', {
          class: 'btn',
          trustedHtml: Icon.Plus({ size: 14 }) + '<span>Today</span>',
          onClick: () => {
            const today = DateUtil.todayKey();
            if (!(today in entries)) {
              entries[today] = '';
            }
            activeDate = today;
            persist();
            render();
          },
        }),
      ]);
      root.append(header);

      const layout = el('div', { class: 'journal-layout' });

      const list = el('div', { class: 'journal-list' });
      const dates = Object.keys(entries).toSorted().toReversed();
      if (dates.length === 0) {
        list.append(
          el('div', { class: 'muted tiny', style: { padding: '8px 12px' } }, 'No entries yet.'),
        );
      } else {
        for (const d of dates) {
          const text = entries[d] || '';
          const item = el(
            'button',
            {
              class: 'journal-list-item',
              'data-active': String(d === activeDate),
              onClick: () => {
                activeDate = d;
                render();
              },
            },
            [
              el('div', { class: 'date' }, DateUtil.formatShort(d)),
              text
                ? el('div', { class: 'preview' }, text.slice(0, 80))
                : el('div', { class: 'preview muted' }, 'Empty'),
            ],
          );
          list.append(item);
        }
      }

      const editor = el('div', { class: 'journal-editor' });
      editor.append(el('div', { class: 'journal-date-label' }, DateUtil.formatDate(activeDate)));
      const ta = el('textarea', {
        class: 'journal-textarea',
        placeholder: 'What happened today?',
      }) as HTMLTextAreaElement;
      ta.value = entries[activeDate] || '';
      ta.addEventListener('input', () => {
        entries[activeDate] = ta.value;
        persist();
        const item = list.querySelector(`button[data-active="true"] .preview`);
        if (item) {
          item.textContent = (ta.value || '').slice(0, 80) || '—';
        }
      });

      const actions = el('div', { class: 'flex gap-2' }, [
        el('button', {
          class: 'btn btn-ghost',
          trustedHtml: Icon.Trash({ size: 14 }) + '<span>Delete entry</span>',
          onClick: () => {
            delete entries[activeDate];
            const remaining = Object.keys(entries).toSorted().toReversed();
            activeDate = remaining[0] || DateUtil.todayKey();
            if (!(activeDate in entries)) {
              entries[activeDate] = '';
            }
            persist();
            render();
          },
        }),
      ]);

      editor.append(ta);
      editor.append(actions);

      layout.append(list);
      layout.append(editor);
      root.append(layout);

      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
    render();
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.journal = { mount };
})();
