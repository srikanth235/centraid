(function () {
  const STORAGE = 'mood.log';
  type MoodLog = Record<string, number>;
  const MOODS = ['😔', '😐', '🙂', '😄', '✨'];
  const LABEL = ['Low', 'Meh', 'Okay', 'Good', 'Bright'];

  function mount(root: HTMLElement): void {
    const log = Store.get<MoodLog>(STORAGE, {});
    const persist = (): void => Store.set(STORAGE, log);
    const today = DateUtil.todayKey();
    const { el } = window.Centraid;

    function average30(): number | null {
      const days = 30;
      let sum = 0;
      let count = 0;
      for (let i = 0; i < days; i++) {
        const v = log[DateUtil.daysAgoKey(i)];
        if (typeof v === 'number') {
          sum += v;
          count++;
        }
      }
      return count === 0 ? null : sum / count;
    }

    function render(): void {
      root.innerHTML = '';
      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Mood'),
          el('p', { class: 'app-subtitle' }, 'A 5-second daily check-in.'),
        ]),
      ]);
      root.append(header);

      const todayPick = log[today];
      root.append(el('div', { class: 'mood-prompt' }, 'How are you feeling, today?'));

      const row = el('div', { class: 'mood-row' });
      MOODS.forEach((emoji, i) => {
        row.append(
          el(
            'button',
            {
              'aria-label': LABEL[i],
              class: 'mood-btn',
              'data-on': String(todayPick === i),
              onClick: () => {
                if (log[today] === i) {
                  delete log[today];
                } else {
                  log[today] = i;
                }
                persist();
                render();
              },
            },
            emoji,
          ),
        );
      });
      root.append(row);

      const avg = average30();
      const statText =
        avg == null
          ? 'Log a few days to see your trend.'
          : `30-day average · ${LABEL[Math.round(avg)]} (${avg.toFixed(1)} of 4)`;
      root.append(el('div', { class: 'tiny muted mt-2' }, statText));

      const grid = el('div', { class: 'mood-history mt-3' });
      for (let i = 29; i >= 0; i--) {
        const k = DateUtil.daysAgoKey(i);
        const v = log[k];
        const cell = el(
          'div',
          {
            class: 'mood-history-cell',
            title: `${DateUtil.formatShort(k)} — ${typeof v === 'number' ? LABEL[v] : 'No entry'}`,
          },
          typeof v === 'number' ? MOODS[v] : '',
        );
        if (k === today) {
          cell.style.outline = '2px solid var(--accent-color, var(--accent))';
        }
        grid.append(cell);
      }
      root.append(el('div', { class: 'tiny muted mt-2' }, 'Last 30 days'));
      root.append(grid);
    }
    render();
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.mood = { mount };
})();
