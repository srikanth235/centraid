import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  appLiveUrl: vi.fn(),
  appLogs: vi.fn(),
  deleteAutomation: vi.fn(),
  listAutomations: vi.fn(),
  listVersions: vi.fn(),
  readAutomationTurn: vi.fn(),
  runAutomationNow: vi.fn(),
  setAutomationEnabled: vi.fn(),
}));

vi.mock(import('../../../../gateway-client.js'), () => api);

const { default: BuilderCloud } = await import('./BuilderCloud.js');

function automationRow(): CentraidAutomationRow {
  const triggers: CentraidAutomationManifest['triggers'] = [
    { kind: 'cron', expr: '0 9 * * *' },
    { kind: 'webhook', id: 'hook-1' },
  ];
  return {
    id: 'invoice-watcher',
    dir: '/apps/invoice-watcher',
    name: 'Invoice watcher',
    triggers,
    enabled: true,
    ownerApp: 'invoice-watcher',
    ref: 'invoice-watcher/invoice-watcher',
    manifest: {
      name: 'Invoice watcher',
      version: '0.1.0',
      enabled: true,
      prompt: 'Watch invoices and send a reminder.',
      triggers,
      requires: { model: 'openai/gpt-test' },
      history: { keep: { count: 100 } },
      generated: { by: 'agent', at: '2026-07-25T00:00:00.000Z' },
      apps: ['invoices'],
    },
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(appId = 'invoices'): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<BuilderCloud appId={appId} />);
  });
  return container;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`missing button ${label}`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('BuilderCloud', () => {
  beforeEach(() => {
    api.appLiveUrl.mockReset().mockResolvedValue({
      url: 'https://gateway.test/centraid/invoices/',
    });
    api.appLogs.mockReset().mockResolvedValue({
      entries: [
        {
          ts: Date.UTC(2026, 6, 25, 9, 8, 7),
          level: 'info',
          source: 'query',
          handler: 'list',
          msg: 'invoice loaded',
        },
        {
          ts: Date.UTC(2026, 6, 25, 9, 8, 8),
          level: 'error',
          source: 'action',
          handler: 'send',
          msg: 'delivery failed',
        },
      ],
    });
    api.listVersions.mockReset().mockResolvedValue({
      activeVersion: 'v2',
      versions: [
        {
          versionId: 'v1',
          sha256: 'one',
          declaredVersion: '1',
          uploadedAt: '2026-07-24T00:00:00.000Z',
          bytes: 0,
          files: 0,
        },
        {
          versionId: 'v2',
          sha256: 'two',
          declaredVersion: '2',
          uploadedAt: '2026-07-25T00:00:00.000Z',
          bytes: 0,
          files: 0,
          current: true,
        },
      ],
    });
    api.listAutomations.mockReset().mockResolvedValue([automationRow()]);
    api.setAutomationEnabled.mockReset().mockResolvedValue({ enabled: false });
    api.runAutomationNow.mockReset().mockResolvedValue({ turnId: 'turn-1' });
    api.readAutomationTurn.mockReset().mockResolvedValue({
      turnId: 'turn-1',
      conversationId: 'conversation-1',
      automationRef: 'invoice-watcher/invoice-watcher',
      startedAt: 100,
      endedAt: 125,
      ok: true,
    });
    api.deleteAutomation.mockReset().mockResolvedValue({ deleted: true });
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.querySelectorAll('[class*="toast"]').forEach((node) => node.remove());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('BuilderCloud', () => {
    it('drives overview, logs, and every automation lifecycle action', async () => {
      const el = await mount();

      expect(el.textContent).toContain('LIVE · V2');
      expect(el.textContent).toContain('gateway.test/centraid/invoices/');
      expect(el.textContent).toContain('Published v2');
      expect(el.textContent).toContain('Reachable');
      expect(api.listVersions).toHaveBeenCalledWith({ id: 'invoices' });

      await click(button(el, 'Open'));
      await click(button(el, 'Copy'));
      await click(button(el, 'Share'));
      expect(window.open).toHaveBeenCalledWith('https://gateway.test/centraid/invoices/', '_blank');
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);

      await click(button(el, 'Logs'));
      await expect(vi.waitFor(() => el.textContent?.includes('invoice loaded'))).resolves.toBe(
        true,
      );
      expect(el.querySelectorAll('[data-testid="cloud-logs-row"]')).toHaveLength(2);

      await click(button(el, 'Error'));
      expect(el.textContent).not.toContain('invoice loaded');
      expect(el.textContent).toContain('delivery failed');
      const search = el.querySelector('[data-testid="cloud-logs-search"]') as HTMLInputElement;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(search, 'missing');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(el.textContent).toContain('No logs match the current filter.');
      await click(button(el, 'Refresh'));
      expect(api.appLogs).toHaveBeenCalledTimes(2);

      await click(button(el, 'Automations'));
      await expect(vi.waitFor(() => el.textContent?.includes('Invoice watcher'))).resolves.toBe(
        true,
      );
      expect(el.textContent).toContain('0 9 * * * · webhook');
      expect(el.textContent).toContain('openai/gpt-test');

      const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
      await act(async () => {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(api.setAutomationEnabled).toHaveBeenCalledWith({
        automationId: 'invoice-watcher/invoice-watcher',
        enabled: false,
      });

      await click(button(el, 'Run now'));
      await expect(vi.waitFor(() => el.textContent?.includes('OK in 25ms'))).resolves.toBe(true);
      expect(api.runAutomationNow).toHaveBeenCalledWith({
        automationId: 'invoice-watcher/invoice-watcher',
      });
      expect(api.readAutomationTurn).toHaveBeenCalledWith({ turnId: 'turn-1' });

      await click(button(el, 'Delete'));
      expect(confirm).toHaveBeenCalledWith(
        'Delete automation "Invoice watcher"?\n\nThis permanently removes the automation app directory and its run history.',
      );
      expect(api.deleteAutomation).toHaveBeenCalledWith({
        automationId: 'invoice-watcher/invoice-watcher',
      });
    });

    it('renders empty and failed fetch states without leaking raw exceptions', async () => {
      api.listVersions.mockRejectedValueOnce(new Error('not published'));
      api.appLogs.mockRejectedValueOnce(new Error('logs unavailable'));
      api.listAutomations.mockRejectedValueOnce('offline');
      const el = await mount();

      expect(el.textContent).toContain('NOT DEPLOYED');
      expect(el.textContent).toContain('No activity yet');

      await click(button(el, 'Logs'));
      await expect(
        vi.waitFor(() => el.textContent?.includes('Could not load logs.')),
      ).resolves.toBe(true);
      expect(el.textContent).toContain('logs unavailable');

      await click(button(el, 'Automations'));
      await expect(
        vi.waitFor(() => el.textContent?.includes('Could not load automations.')),
      ).resolves.toBe(true);
      expect(el.textContent).toContain('offline');
    });

    it('renders the no-app overview without making gateway calls', async () => {
      const el = await mount('');
      expect(el.textContent).toContain('No app yet.');
      expect(api.listVersions).not.toHaveBeenCalled();
    });
  });
});
