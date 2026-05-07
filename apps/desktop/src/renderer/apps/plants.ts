(function () {
  const STORAGE = 'plants.list';
  interface Plant {
    id: number;
    name: string;
    intervalDays: number;
    lastWatered: string | null;
  }
  interface Status {
    text: string;
    due?: boolean;
    overdue?: boolean;
    when?: number;
  }

  function mount(root: HTMLElement): void {
    let plants = Store.get<Plant[]>(STORAGE, [
      { id: 1, intervalDays: 7, lastWatered: DateUtil.daysAgoKey(5), name: 'Monstera' },
      { id: 2, intervalDays: 5, lastWatered: DateUtil.daysAgoKey(5), name: 'Pothos' },
      { id: 3, intervalDays: 10, lastWatered: DateUtil.daysAgoKey(6), name: 'Fiddle leaf' },
      { id: 4, intervalDays: 14, lastWatered: DateUtil.daysAgoKey(9), name: 'Succulents' },
    ]);
    let nextId = (plants.reduce((m, p) => Math.max(m, p.id), 0) || 0) + 1;
    const persist = (): void => Store.set(STORAGE, plants);
    const { el } = window.Centraid;

    function daysSince(dateKey: string | null): number {
      if (!dateKey) {
        return Infinity;
      }
      const ms = Date.now() - new Date(dateKey + 'T00:00:00').getTime();
      return Math.floor(ms / (1000 * 60 * 60 * 24));
    }

    function status(p: Plant): Status {
      const since = daysSince(p.lastWatered);
      if (since === Infinity) {
        return { due: true, overdue: true, text: 'Never watered' };
      }
      const left = p.intervalDays - since;
      if (left < 0) {
        return {
          due: true,
          overdue: true,
          text: `Overdue by ${-left} day${-left === 1 ? '' : 's'}`,
        };
      }
      if (left === 0) {
        return { due: true, text: 'Water today' };
      }
      if (left === 1) {
        return { text: 'Water tomorrow' };
      }
      return { text: `Next in ${left} days`, when: since };
    }

    function render(): void {
      root.innerHTML = '';
      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Plant Care'),
          el('p', { class: 'app-subtitle' }, 'Watering reminders for my plants.'),
        ]),
      ]);
      root.append(header);

      const nameInput = el('input', {
        placeholder: 'Plant name…',
        type: 'text',
      }) as HTMLInputElement;
      const daysInput = el('input', {
        max: '90',
        min: '1',
        style: { textAlign: 'right', width: '70px' },
        type: 'number',
        value: '7',
      }) as HTMLInputElement;
      const addBtn = el('button', {
        class: 'btn btn-primary',
        trustedHtml: Icon.Plus({ size: 14 }) + '<span>Add</span>',
      });
      const submit = (): void => {
        const name = nameInput.value.trim();
        const intervalDays = Math.max(1, Number.parseInt(daysInput.value, 10) || 7);
        if (!name) {
          return;
        }
        plants.push({ id: nextId++, intervalDays, lastWatered: null, name });
        persist();
        render();
      };
      addBtn.addEventListener('click', submit);
      nameInput.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          submit();
        }
      });
      const intervalLabel = el('span', { class: 'tiny muted' }, 'every');
      const dayUnit = el('span', { class: 'tiny muted' }, 'days');

      root.append(
        el('div', { class: 'add-bar' }, [nameInput, intervalLabel, daysInput, dayUnit, addBtn]),
      );

      const sorted = [...plants].toSorted((a, b) => {
        const sa = status(a);
        const sb = status(b);
        const score = (s: Status): number => (s.overdue ? 0 : s.due ? 1 : 2);
        return score(sa) - score(sb);
      });

      if (sorted.length === 0) {
        root.append(el('div', { class: 'empty' }, 'No plants yet. Add one above.'));
        return;
      }

      const list = el('div', {});
      for (const p of sorted) {
        const s = status(p);
        const water = el('button', {
          class: 'btn btn-soft',
          trustedHtml: Icon.Water({ size: 14 }) + '<span>Water</span>',
          onClick: () => {
            p.lastWatered = DateUtil.todayKey();
            persist();
            render();
          },
          style: { padding: '8px 12px' },
        });
        const del = el('button', {
          'aria-label': 'Delete',
          class: 'btn-icon',
          trustedHtml: Icon.Trash({ size: 16 }),
          onClick: () => {
            plants = plants.filter((x) => x.id !== p.id);
            persist();
            render();
          },
        });
        const meta = el('div', { class: 'plant-meta' }, [
          el('div', { class: 'plant-name' }, p.name),
          el(
            'div',
            {
              class: 'plant-status',
              'data-due': String(!!s.due && !s.overdue),
              'data-overdue': String(!!s.overdue),
            },
            `Every ${p.intervalDays} day${p.intervalDays === 1 ? '' : 's'} · ${s.text}`,
          ),
        ]);
        list.append(el('div', { class: 'plant-row' }, [meta, water, del]));
      }
      root.append(list);
    }
    render();
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.plants = { mount };
})();
