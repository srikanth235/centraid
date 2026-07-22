import type { CompanionModule, CompanionRequest, ModuleStatus, PageCapture } from './types.js';
import { blockingSummary, pausedModuleStatuses } from './popup-state.js';

interface Envelope<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

async function send<T>(message: CompanionRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(message)) as Envelope<T> | undefined;
  if (!response?.ok) throw new Error(response?.error ?? 'Request failed.');
  return response.value as T;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector(`#${id}`);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function activeTab(): Promise<ChromeTab | undefined> {
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

async function capturePage(): Promise<{ tab: ChromeTab; capture: PageCapture }> {
  const tab = await activeTab();
  if (!tab?.id || !tab.url) throw new Error('No capturable tab is active.');
  const capture = (await chrome.tabs
    .sendMessage(tab.id, { type: 'page:capture' })
    .catch(async () => {
      await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
      return chrome.tabs.sendMessage(tab.id!, { type: 'page:capture' });
    })) as PageCapture;
  return { tab, capture };
}

function setNotice(text: string, kind: 'ok' | 'error' = 'ok'): void {
  const notice = byId('notice');
  notice.textContent = text;
  notice.dataset['kind'] = kind;
}

function applyModuleAvailability(modules: readonly ModuleStatus[]): void {
  const available = new Map(modules.map((module) => [module.id, module.state === 'granted']));
  for (const [module, elementId] of [
    ['tasks', 'task'],
    ['notes', 'note'],
    ['docs', 'document'],
  ] as const) {
    byId<HTMLButtonElement>(elementId).disabled = !available.get(module);
  }
  byId('agenda-module').hidden = !available.get('agenda');
  byId('people-module').hidden = !available.get('people');
}

function renderModules(modules: readonly ModuleStatus[]): void {
  applyModuleAvailability(modules);
  const list = byId('modules');
  list.replaceChildren();
  for (const module of modules) {
    const row = document.createElement('li');
    row.innerHTML = '<span></span><small></small>';
    row.querySelector('span')!.textContent = module.name;
    row.querySelector('small')!.textContent = module.state;
    row.dataset['state'] = module.state;
    list.append(row);
  }
}

async function render(): Promise<void> {
  const status = await send<{
    paired: boolean;
    locked: boolean;
    pairing?: {
      gatewayName?: string;
      vaultName?: string;
      grantProfile?: readonly CompanionModule[];
    };
  }>({ type: 'status' });
  byId('pairing').hidden = status.paired;
  byId('companion').hidden = !status.paired;
  if (!status.paired) return;
  byId('gateway').textContent = status.pairing?.gatewayName ?? 'Paired gateway';
  byId('vault').textContent = status.pairing?.vaultName ?? 'Personal vault';
  byId<HTMLButtonElement>('lock').textContent = status.locked ? 'Unlock' : 'Lock';
  byId('actions').toggleAttribute('inert', status.locked);
  const paused = pausedModuleStatuses(status.pairing?.grantProfile ?? []);
  if (status.locked) {
    renderModules(paused);
    byId('approvals').textContent = 'Approvals paused while Companion is locked.';
    return;
  }
  try {
    const [modules, blocking] = await Promise.all([
      send<ModuleStatus[]>({ type: 'modules' }),
      send<{ count: number }>({ type: 'blocking-count' }),
    ]);
    renderModules(modules);
    byId('approvals').textContent = blockingSummary(blocking.count);
  } catch (error) {
    renderModules(paused);
    byId('approvals').textContent = 'Approval count paused while the gateway is unreachable.';
    setNotice(errorText(error), 'error');
  }
}

byId<HTMLFormElement>('pair-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const ticket = byId<HTMLTextAreaElement>('ticket').value;
  const grants = [...document.querySelectorAll<HTMLInputElement>('[name="grant"]:checked')].map(
    (input) => input.value as CompanionModule,
  );
  void send({ type: 'pair', ticket, grants }).then(
    () => {
      setNotice('Paired. This device now follows your Centraid grants.');
      return render();
    },
    (error) => setNotice(errorText(error), 'error'),
  );
});

byId('scan').addEventListener('click', () => window.open('pair.html', '_blank'));
byId('lock').addEventListener('click', () => {
  void send<{ locked: boolean }>({ type: 'status' }).then((status) =>
    send({ type: status.locked ? 'unlock' : 'lock' }).then(() => render()),
  );
});
byId('unpair').addEventListener('click', () => {
  if (!confirm('Revoke this browser from the gateway and delete its local device identity?'))
    return;
  void send({ type: 'unpair' }).then(
    () => render(),
    (error) => setNotice(`Could not revoke this device: ${errorText(error)}`, 'error'),
  );
});

for (const [id, kind] of [
  ['task', 'capture:task'],
  ['note', 'capture:note'],
] as const) {
  byId(id).addEventListener('click', () => {
    void capturePage().then(
      ({ capture }) => send({ type: kind, capture }).then(() => setNotice('Captured in Centraid.')),
      (error) => setNotice(errorText(error), 'error'),
    );
  });
}

byId('document').addEventListener('click', () => {
  void capturePage().then(
    async ({ tab, capture }) => {
      const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      await send({ type: 'capture:document', capture, screenshot });
      setNotice('Screenshot saved to Docs.');
    },
    (error) => setNotice(errorText(error), 'error'),
  );
});

byId<HTMLFormElement>('agenda-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const summary = byId<HTMLInputElement>('agenda-summary').value;
  const start = new Date(byId<HTMLInputElement>('agenda-start').value).toISOString();
  const end = new Date(byId<HTMLInputElement>('agenda-end').value).toISOString();
  const calendarId = byId<HTMLInputElement>('agenda-calendar').value;
  void send({ type: 'agenda:add', summary, start, end, calendarId }).then(
    () => setNotice('Event proposed in Agenda.'),
    (error) => setNotice(errorText(error), 'error'),
  );
});

byId<HTMLFormElement>('people-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const displayName = byId<HTMLInputElement>('person-name').value;
  const role = byId<HTMLInputElement>('person-role').value;
  const cadenceDays = Number(byId<HTMLInputElement>('person-cadence').value);
  void send({ type: 'people:add', displayName, role, cadenceDays }).then(
    () => setNotice('Person added to your circle.'),
    (error) => setNotice(errorText(error), 'error'),
  );
});

void render().catch((error) => setNotice(errorText(error), 'error'));
