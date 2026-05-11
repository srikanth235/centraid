// Hydrate — frontend.
// Fetches today's state from the query, mutates via the set-cups action.
// All paths are relative to /centraid/<app-id>/, so the iframe's same-origin
// fetch hits this app's handlers automatically.

const $ = (id) => document.getElementById(id);

let state = { date: '', cups: 0, goal: 8 };

async function refresh() {
  const res = await fetch('_data/get-today');
  if (!res.ok) return;
  state = await res.json();
  render();
}

async function setCups(n) {
  const res = await fetch('_run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-cups', args: { cups: n } }),
  });
  if (!res.ok) return;
  state = await res.json();
  render();
}

function render() {
  const count = $('count');
  count.innerHTML = '';
  count.append(document.createTextNode(String(state.cups)));
  const small = document.createElement('span');
  small.className = 'count-small';
  small.textContent = ` / ${state.goal}`;
  count.append(small);

  const grid = $('grid');
  grid.innerHTML = '';
  for (let i = 0; i < state.goal; i++) {
    const filled = i < state.cups;
    const btn = document.createElement('button');
    btn.className = 'cup' + (filled ? ' filled' : '');
    btn.type = 'button';
    btn.setAttribute('aria-label', `Cup ${i + 1}`);
    btn.setAttribute('aria-pressed', String(filled));
    btn.addEventListener('click', () => {
      const next = i + 1 > state.cups ? i + 1 : i;
      void setCups(next);
    });
    grid.append(btn);
  }

  const add = $('add');
  add.disabled = state.cups >= state.goal;
  add.onclick = () => void setCups(state.cups + 1);

  const reset = $('reset');
  reset.onclick = () => void setCups(0);

  $('done').hidden = state.cups < state.goal;
}

void refresh();
