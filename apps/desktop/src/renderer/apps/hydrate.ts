(function () {
  const STORAGE = 'hydrate.daily';
  const GOAL = 8;
  interface HydrateState {
    date: string;
    cups: number;
  }

  function mount(root: HTMLElement): void {
    let state = Store.get<HydrateState>(STORAGE, { cups: 0, date: DateUtil.todayKey() });
    if (state.date !== DateUtil.todayKey()) {
      state = { cups: 0, date: DateUtil.todayKey() };
      Store.set(STORAGE, state);
    }
    const persist = (): void => Store.set(STORAGE, state);
    const { el } = window.Centraid;

    function set(n: number): void {
      state.cups = Math.max(0, Math.min(GOAL, n));
      persist();
      render();
    }

    function render(): void {
      root.innerHTML = '';
      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Hydrate'),
          el('p', { class: 'app-subtitle' }, `Track ${GOAL} cups a day.`),
        ]),
      ]);
      root.append(header);

      const count = el('div', { class: 'hydrate-count' });
      count.innerHTML = `${state.cups}<small> / ${GOAL}</small>`;
      root.append(count);

      const grid = el('div', { class: 'hydrate-grid' });
      for (let i = 0; i < GOAL; i++) {
        const filled = i < state.cups;
        grid.append(
          el('button', {
            'aria-label': filled ? `Cup ${i + 1} filled` : `Cup ${i + 1} empty`,
            class: 'hydrate-cup',
            'data-on': String(filled),
            trustedHtml: filled ? Icon.Water({ size: 28, strokeWidth: 1.75 }) : '',
            onClick: () => {
              if (i + 1 > state.cups) {
                set(i + 1);
              } else {
                set(i);
              }
            },
          }),
        );
      }
      root.append(grid);

      const actions = el('div', { class: 'hydrate-actions' }, [
        el('button', {
          class: 'btn btn-primary',
          disabled: state.cups >= GOAL ? '' : null,
          trustedHtml: Icon.Plus({ size: 14 }) + '<span>Log a cup</span>',
          onClick: () => set(state.cups + 1),
          style: { borderRadius: '999px', padding: '12px 22px' },
        }),
        el('button', {
          class: 'btn btn-soft',
          trustedHtml: Icon.Reset({ size: 14 }) + '<span>Reset</span>',
          onClick: () => set(0),
        }),
      ]);
      root.append(actions);

      if (state.cups >= GOAL) {
        root.append(
          el(
            'div',
            {
              class: 'mt-3',
              style: { color: 'var(--ink-3)', fontSize: '13px', textAlign: 'center' },
            },
            'Done for today. 💧',
          ),
        );
      }
    }

    render();
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.hydrate = { mount };
})();
