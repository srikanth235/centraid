(function () {
  const STORAGE = 'todos.list';
  interface Todo {
    id: number;
    text: string;
    done: boolean;
  }

  function mount(root: HTMLElement): void {
    let todos = Store.get<Todo[]>(STORAGE, [
      { done: false, id: 1, text: 'Email back Maya' },
      { done: false, id: 2, text: 'Pick up dry cleaning' },
      { done: false, id: 3, text: 'Replace shower head' },
    ]);
    let nextId = (todos.reduce((m, t) => Math.max(m, t.id), 0) || 0) + 1;

    const persist = (): void => Store.set(STORAGE, todos);
    const { el } = window.Centraid;

    function render(): void {
      root.innerHTML = '';
      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Todos'),
          el('p', { class: 'app-subtitle' }, 'Capture and clear small things.'),
        ]),
        el('div', { class: 'muted tiny' }, `${todos.filter((t) => !t.done).length} open`),
      ]);

      const addInput = el('input', {
        placeholder: 'Add something to do…',
        type: 'text',
      }) as HTMLInputElement;
      const addBtn = el('button', {
        class: 'btn btn-primary',
        trustedHtml: Icon.Plus({ size: 14 }) + '<span>Add</span>',
      });
      const addBar = el('div', { class: 'add-bar' }, [addInput, addBtn]);

      const submit = (): void => {
        const text = addInput.value.trim();
        if (!text) {
          return;
        }
        todos.unshift({ done: false, id: nextId++, text });
        persist();
        render();
      };
      addBtn.addEventListener('click', submit);
      addInput.addEventListener('keydown', (e) => {
        if ((e as KeyboardEvent).key === 'Enter') {
          submit();
        }
      });

      root.append(header);
      root.append(addBar);

      const list = el('div', {});
      const open = todos.filter((t) => !t.done);
      const done = todos.filter((t) => t.done);

      if (open.length === 0 && done.length === 0) {
        list.append(el('div', { class: 'empty' }, 'Nothing on your list. Add one above.'));
      }

      open.forEach((t) => list.append(renderRow(t)));
      if (done.length) {
        list.append(
          el(
            'div',
            { class: 'muted tiny mt-3', style: { marginBottom: '8px' } },
            `Done · ${done.length}`,
          ),
        );
        done.forEach((t) => list.append(renderRow(t)));
      }
      root.append(list);

      addInput.focus();

      function renderRow(t: Todo): HTMLElement {
        const circle = el('button', {
          'aria-label': t.done ? 'Mark as not done' : 'Mark as done',
          class: 'tap-circle',
          'data-on': String(t.done),
          trustedHtml: t.done ? Icon.Check({ size: 14, strokeWidth: 2.5 }) : '',
          onClick: () => {
            t.done = !t.done;
            persist();
            render();
          },
        });
        const text = el(
          'div',
          {
            class: 'flex-1',
            style: {
              color: t.done ? 'var(--ink-3)' : 'var(--ink)',
              fontSize: '14px',
              textDecoration: t.done ? 'line-through' : 'none',
            },
          },
          t.text,
        );
        const del = el('button', {
          'aria-label': 'Delete',
          class: 'btn-icon',
          trustedHtml: Icon.Trash({ size: 16 }),
          onClick: () => {
            todos = todos.filter((x) => x.id !== t.id);
            persist();
            render();
          },
        });
        return el('div', { class: 'row' }, [circle, text, del]);
      }
    }

    render();
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.todos = { mount };
})();
