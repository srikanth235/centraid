(function () {
  const STORAGE = 'habits.list';
  interface Habit {
    id: number;
    name: string;
    log: string[];
  }

  function mount(root: HTMLElement): void {
    function seedLog(days: number): string[] {
      const out: string[] = [];
      for (let i = 0; i < days; i++) {
        out.push(DateUtil.daysAgoKey(i));
      }
      return out;
    }

    let habits = Store.get<Habit[]>(STORAGE, [
      { id: 1, log: seedLog(12), name: 'Read 20 pages' },
      { id: 2, log: seedLog(4), name: 'Walk 30 min' },
      { id: 3, log: seedLog(18), name: 'No phone in bed' },
      { id: 4, log: seedLog(7), name: 'Drink water' },
    ]);
    let nextId = (habits.reduce((m, h) => Math.max(m, h.id), 0) || 0) + 1;
    const persist = (): void => Store.set(STORAGE, habits);
    const { el } = window.Centraid;

    function streakOf(h: Habit): number {
      let s = 0;
      for (let i = 0; i < 365; i++) {
        if (h.log.includes(DateUtil.daysAgoKey(i))) {
          s++;
        } else {
          break;
        }
      }
      return s;
    }

    function render(): void {
      root.innerHTML = '';
      const today = DateUtil.todayKey();

      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Habits'),
          el('p', { class: 'app-subtitle' }, DateUtil.formatDate(today)),
        ]),
      ]);
      root.append(header);

      const addInput = el('input', {
        placeholder: 'Add a habit…',
        type: 'text',
      }) as HTMLInputElement;
      const addBtn = el('button', {
        class: 'btn btn-primary',
        trustedHtml: Icon.Plus({ size: 14 }) + '<span>Add</span>',
      });
      const submit = (): void => {
        const name = addInput.value.trim();
        if (!name) {
          return;
        }
        habits.push({ id: nextId++, log: [], name });
        persist();
        render();
      };
      addBtn.addEventListener('click', submit);
      addInput.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          submit();
        }
      });
      root.append(el('div', { class: 'add-bar' }, [addInput, addBtn]));

      if (habits.length === 0) {
        root.append(el('div', { class: 'empty' }, 'Add a habit to start tracking it.'));
        return;
      }

      const list = el('div', {});
      for (const h of habits) {
        const doneToday = h.log.includes(today);
        const circle = el('button', {
          class: 'tap-circle',
          'data-on': String(doneToday),
          trustedHtml: doneToday ? Icon.Check({ size: 14, strokeWidth: 2.5 }) : '',
          onClick: () => {
            if (doneToday) {
              h.log = h.log.filter((d) => d !== today);
            } else {
              h.log = [today, ...h.log];
            }
            persist();
            render();
          },
        });

        const week = el('div', { class: 'habits-week' });
        for (let i = 6; i >= 0; i--) {
          const k = DateUtil.daysAgoKey(i);
          const on = h.log.includes(k);
          week.append(
            el('span', {
              class: 'habits-dot',
              'data-on': String(on),
              'data-today': i === 0 ? 'true' : 'false',
              trustedHtml: on ? Icon.Check({ size: 7, strokeWidth: 3 }) : '',
            }),
          );
        }
        week.append(el('span', { class: 'habits-streak' }, `${streakOf(h)} day streak`));

        const meta = el('div', { class: 'flex-1', style: { minWidth: '0' } }, [
          el('div', { class: 'habits-name' }, h.name),
          week,
        ]);

        const del = el('button', {
          'aria-label': 'Delete',
          class: 'btn-icon',
          trustedHtml: Icon.Trash({ size: 16 }),
          onClick: () => {
            habits = habits.filter((x) => x.id !== h.id);
            persist();
            render();
          },
        });

        list.append(el('div', { class: 'habits-row' }, [circle, meta, del]));
      }
      root.append(list);
    }
    render();
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.habits = { mount };
})();
