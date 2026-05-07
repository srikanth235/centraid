(function () {
  const STORAGE = 'gifts.list';
  interface Gift {
    id: number;
    recipient: string;
    idea: string;
    bought: boolean;
  }

  function mount(root: HTMLElement): void {
    let gifts = Store.get<Gift[]>(STORAGE, [
      {
        bought: false,
        id: 1,
        idea: 'That ceramic mug from Tortus, for her birthday.',
        recipient: 'Mom',
      },
      { bought: false, id: 2, idea: 'A year of fancy hot sauce.', recipient: 'Sam' },
      { bought: false, id: 3, idea: 'The hiking book she keeps mentioning.', recipient: 'Riley' },
    ]);
    let nextId = (gifts.reduce((m, g) => Math.max(m, g.id), 0) || 0) + 1;
    const persist = (): void => Store.set(STORAGE, gifts);
    const { el } = window.Centraid;

    function render(): void {
      root.innerHTML = '';
      const header = el('div', { class: 'app-header' }, [
        el('div', {}, [
          el('h1', { class: 'app-title' }, 'Gift Ideas'),
          el('p', { class: 'app-subtitle' }, 'Half-formed ideas for friends.'),
        ]),
      ]);
      root.append(header);

      const recipient = el('input', {
        class: 'input',
        placeholder: 'For whom?',
        type: 'text',
      }) as HTMLInputElement;
      const idea = el('textarea', {
        class: 'textarea',
        placeholder: 'The idea — even half-formed.',
      }) as HTMLTextAreaElement;
      const submit = (): void => {
        const r = recipient.value.trim();
        const i = idea.value.trim();
        if (!r || !i) {
          return;
        }
        gifts.unshift({ bought: false, id: nextId++, idea: i, recipient: r });
        persist();
        render();
      };
      const addBtn = el('button', {
        class: 'btn btn-primary',
        trustedHtml: Icon.Plus({ size: 14 }) + '<span>Save idea</span>',
        onClick: submit,
      });
      const composer = el('div', { class: 'card', style: { marginBottom: '20px' } }, [
        recipient,
        el('div', { style: { height: '8px' } }),
        idea,
        el('div', { class: 'flex mt-1', style: { justifyContent: 'flex-end' } }, [addBtn]),
      ]);
      root.append(composer);

      if (gifts.length === 0) {
        root.append(el('div', { class: 'empty' }, 'No ideas yet. Add one above.'));
        return;
      }

      const list = el('div', {});
      for (const g of gifts) {
        const card = el('div', { class: 'gift-card', 'data-bought': String(g.bought) }, [
          el('div', { class: 'gift-recipient' }, g.recipient),
          el('div', { class: 'gift-text' }, g.idea),
          el('div', { class: 'flex gap-2 mt-1' }, [
            el('button', {
              class: 'btn btn-soft',
              trustedHtml:
                (g.bought ? Icon.Check({ size: 14, strokeWidth: 2.5 }) : Icon.Check({ size: 14 })) +
                `<span>${g.bought ? 'Bought' : 'Mark as bought'}</span>`,
              onClick: () => {
                g.bought = !g.bought;
                persist();
                render();
              },
            }),
            el('button', {
              'aria-label': 'Delete',
              class: 'btn-icon',
              trustedHtml: Icon.Trash({ size: 16 }),
              onClick: () => {
                gifts = gifts.filter((x) => x.id !== g.id);
                persist();
                render();
              },
            }),
          ]),
        ]);
        list.append(card);
      }
      root.append(list);
    }
    render();
  }

  window.CentraidApps = window.CentraidApps || {};
  window.CentraidApps.gifts = { mount };
})();
