// Hydrate — frontend.
// Fetches today's state from the query, mutates via the set-cups action.
// All paths are relative to /centraid/<app-id>/, so the iframe's same-origin
// fetch hits this app's handlers automatically.
//
// Mobile bridge: when running inside the Centraid mobile WebView, the shell
// injects `window.centraid` (see apps/mobile/src/lib/bridge). We feature-
// detect everything so the same template still works in the desktop
// iframe, which doesn't have the bridge.

const $ = (id) => document.getElementById(id);

const bridge = typeof window !== 'undefined' ? window.centraid : undefined;

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
  if (n > 0) bridge?.haptic?.selection?.();
  render();
}

async function remindIn(ms) {
  if (!bridge?.notify) return;
  try {
    await bridge.notify.schedule({
      id: 'hydrate-next',
      title: 'Time to hydrate',
      body: 'Log your next cup of water.',
      at: Date.now() + ms,
    });
    bridge.haptic?.success?.();
  } catch (err) {
    if (err && err.code === 'permission_denied') {
      alert('Enable notifications in system settings to use reminders.');
    }
  }
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

  const remind = $('remind');
  if (remind) {
    if (bridge?.notify) {
      remind.hidden = false;
      remind.onclick = () => void remindIn(60 * 60 * 1000);
    } else {
      remind.hidden = true;
    }
  }

  $('done').hidden = state.cups < state.goal;
}

void refresh();

// Re-fetch on every server-observed mutation (chat-assistant writes,
// cross-window edits, etc). The runtime injects `window.centraid.onChange`
// into every served HTML.
window.centraid?.onChange?.(() => void refresh());
