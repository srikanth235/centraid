import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ConnectFlow, { type ConnectFlowProps } from './ConnectFlow.js';

vi.mock(import('../../../gateway-client.js'), () => ({
  listVaults: () => listVaultsMock(),
}));

const listVaultsMock = vi.fn<typeof import('../../../gateway-client.js').listVaults>();
const getSettings = vi.fn<typeof window.CentraidApi.getSettings>();
const setActiveGateway = vi.fn<typeof window.CentraidApi.setActiveGateway>();
const setActiveVault = vi.fn<typeof window.CentraidApi.setActiveVault>();
const createVault = vi.fn<typeof window.CentraidApi.createVault>();
const redeemGatewayPairing = vi.fn<typeof window.CentraidApi.redeemGatewayPairing>();
const addGateway = vi.fn<typeof window.CentraidApi.addGateway>();
const testGatewayConnection = vi.fn<typeof window.CentraidApi.testGatewayConnection>();
const sshConnectGateway = vi.fn<typeof window.CentraidApi.sshConnectGateway>();

function currentSettings(): Awaited<ReturnType<typeof window.CentraidApi.getSettings>> {
  return {
    activeGatewayId: 'local',
    activeGatewayKind: 'local',
    activeGatewayLabel: 'This Mac',
    activeProfileDisplayName: 'This Mac',
    activeProfileAvatarColor: '#4E68DD',
    gatewayUrl: 'http://127.0.0.1:49152',
  };
}

describe('routes/ConnectFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listVaultsMock.mockResolvedValue([
      {
        vaultId: 'a',
        name: 'Personal',
        ownerPartyId: 'party-personal',
        color: '#4E68DD',
      },
    ]);
    getSettings.mockResolvedValue(currentSettings());
    setActiveGateway.mockResolvedValue(currentSettings());
    setActiveVault.mockResolvedValue(currentSettings());
    createVault.mockResolvedValue({ vaultId: 'new1' });
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      addGateway,
      createVault,
      getSettings,
      redeemGatewayPairing,
      setActiveGateway,
      setActiveVault,
      sshConnectGateway,
      testGatewayConnection,
    };
  });

  let root: Root | null = null;
  let container: HTMLDivElement | null = null;
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
  });

  function mount(
    props: Partial<ConnectFlowProps> & Pick<ConnectFlowProps, 'context' | 'onDone'>,
  ): HTMLDivElement {
    container = document.createElement('div');
    document.body.appendChild(container);
    act(() => {
      root = createRoot(container as HTMLDivElement);
      root.render(<ConnectFlow {...props} />);
    });
    return container;
  }

  async function flush(times = 3): Promise<void> {
    const flushNext = async (index: number): Promise<void> => {
      if (index >= times) return;
      await act(async () => {});
      return flushNext(index + 1);
    };
    return flushNext(0);
  }

  function click(el: Element | null | undefined): void {
    act(() => (el as HTMLButtonElement)?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  }

  function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    act(() => {
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // Every radio in the flow is a native <input type="radio"> wrapped in the
  // styled <label> that carries the visible text (issue #573).
  function radios(el: HTMLElement, name: string): HTMLInputElement[] {
    return [...el.querySelectorAll('label')]
      .filter((l) => l.textContent?.includes(name))
      .map((l) => l.querySelector<HTMLInputElement>('input[type="radio"]'))
      .filter((i): i is HTMLInputElement => i !== null);
  }

  describe(ConnectFlow, () => {
    it('renders all three method cards by default', () => {
      const el = mount({
        context: 'onboarding',
        onDone: vi.fn<ConnectFlowProps['onDone']>(),
      });
      expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(3);
      expect(el.textContent).toContain('This Mac');
      expect(el.textContent).toContain('Existing gateway');
      expect(el.textContent).toContain('Over SSH');
    });

    it('a switcher ConnectFlowModal-style caller can omit the "This Mac" card', () => {
      const el = mount({
        context: 'switcher',
        methods: ['gateway', 'ssh'],
        onDone: vi.fn<ConnectFlowProps['onDone']>(),
      });
      expect(el.querySelectorAll('input[type="radio"]')).toHaveLength(2);
      expect(el.textContent).not.toContain('This Mac');
    });

    it('onboarding + "This Mac" with exactly one existing vault completes without another click', async () => {
      const onDone = vi.fn<ConnectFlowProps['onDone']>();
      const el = mount({ context: 'onboarding', onDone });
      click(radios(el, 'This Mac')[0]);
      await flush(4);
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: 'a' });
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: 'This Mac',
        gatewayId: 'local',
        vaultId: 'a',
      });
    });

    it('switcher + "This Mac" with one vault still shows the picker (no auto-commit)', async () => {
      const el = mount({
        context: 'switcher',
        onDone: vi.fn<ConnectFlowProps['onDone']>(),
      });
      click(radios(el, 'This Mac')[0]);
      await flush(3);
      expect(el.querySelector('[role="radiogroup"][aria-label="Space"]')).toBeTruthy();
      expect(setActiveVault).not.toHaveBeenCalled();
    });

    it('local: picking a different existing vault and committing calls setActiveVault + onDone', async () => {
      listVaultsMock.mockResolvedValue([
        { vaultId: 'a', name: 'Personal', ownerPartyId: 'party-personal' },
        { vaultId: 'b', name: 'Work', ownerPartyId: 'party-work' },
      ]);
      const onDone = vi.fn<ConnectFlowProps['onDone']>();
      const el = mount({ context: 'switcher', onDone });
      click(radios(el, 'This Mac')[0]);
      await flush(3);
      const workRow = radios(el, 'Work')[0];
      click(workRow);
      const connectBtn = [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Connect',
      );
      click(connectBtn);
      await flush(3);
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: 'b' });
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: 'This Mac',
        gatewayId: 'local',
        vaultId: 'b',
      });
    });

    it('local: creating a new vault calls createVault + setActiveVault', async () => {
      listVaultsMock.mockResolvedValue([
        { vaultId: 'a', name: 'Personal', ownerPartyId: 'party-personal' },
        { vaultId: 'b', name: 'Work', ownerPartyId: 'party-work' },
      ]);
      const el = mount({
        context: 'switcher',
        onDone: vi.fn<ConnectFlowProps['onDone']>(),
      });
      click(radios(el, 'This Mac')[0]);
      await flush(3);
      const createRow = radios(el, 'Create new space')[0];
      click(createRow);
      typeInto(el.querySelector('input[placeholder="Space name"]') as HTMLInputElement, 'Play');
      const connectBtn = [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Connect',
      );
      click(connectBtn);
      await flush(3);
      expect(createVault).toHaveBeenCalledWith({ name: 'Play' });
      expect(setActiveVault).toHaveBeenCalledWith({ vaultId: 'new1' });
    });

    it('gateway/ticket happy path: test decodes the ticket, vault is locked, commit redeems it', async () => {
      testGatewayConnection.mockResolvedValue({
        ok: true,
        stages: [{ detail: '', id: 'decode', label: 'Decode ticket', status: 'pass' }],
        ticket: {
          expiresAt: '2030-01-01T00:00:00Z',
          gatewayEndpointId: 'ep1',
          vaultName: 'Office',
        },
      });
      redeemGatewayPairing.mockResolvedValue({
        gatewayId: 'gw1',
        ok: true,
        vaultId: 'v1',
        vaultName: 'Office',
      });
      const onDone = vi.fn<ConnectFlowProps['onDone']>();
      const el = mount({ context: 'onboarding', onDone });
      click(radios(el, 'Existing gateway')[0]);
      await flush();
      typeInto(el.querySelector('textarea') as HTMLTextAreaElement, 'a-ticket');
      const continueBtn1 = [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Continue',
      );
      click(continueBtn1);
      await flush(3);
      expect(testGatewayConnection).toHaveBeenCalledWith({
        kind: 'ticket',
        ticket: 'a-ticket',
      });
      expect(el.textContent).toContain('Decode ticket');

      const continueBtn2 = [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Continue',
      );
      click(continueBtn2);
      await flush();
      expect(el.textContent).toContain('Office');

      const connectBtn = [...el.querySelectorAll('button')].find(
        (b) => b.textContent === 'Enter Centraid',
      );
      click(connectBtn);
      await flush(3);
      expect(redeemGatewayPairing).toHaveBeenCalledWith({
        label: undefined,
        rememberDevice: false,
        ticket: 'a-ticket',
      });
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: 'Office',
        gatewayId: 'gw1',
        vaultId: 'v1',
      });
    });

    it('gateway test failure shows Retry, which re-runs the test', async () => {
      testGatewayConnection.mockResolvedValueOnce({
        error: 'invalid_ticket',
        ok: false,
        stages: [{ id: 'decode', label: 'Decode ticket', status: 'fail' }],
      });
      const el = mount({
        context: 'onboarding',
        onDone: vi.fn<ConnectFlowProps['onDone']>(),
      });
      click(radios(el, 'Existing gateway')[0]);
      await flush();
      typeInto(el.querySelector('textarea') as HTMLTextAreaElement, 'bad-ticket');
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Continue'));
      await flush(3);
      const retry = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry');
      expect(retry).toBeTruthy();

      testGatewayConnection.mockResolvedValueOnce({
        ok: true,
        stages: [],
        ticket: { expiresAt: '', gatewayEndpointId: '', vaultName: 'Office' },
      });
      click(retry);
      await flush(3);
      expect(testGatewayConnection).toHaveBeenCalledTimes(2);
    });

    it('ssh happy path: test probes the host, existing vault picked, commit calls sshConnectGateway', async () => {
      testGatewayConnection.mockResolvedValue({
        ok: true,
        stages: [{ id: 'ssh', label: 'Host reachable', status: 'pass' }],
        vaults: [{ name: 'Remote space', vaultId: 'r1' }],
      });
      sshConnectGateway.mockResolvedValue({
        gatewayId: 'gwssh',
        ok: true,
        vaultId: 'r1',
        vaultName: 'Remote space',
      });
      const onDone = vi.fn<ConnectFlowProps['onDone']>();
      const el = mount({
        context: 'switcher',
        methods: ['gateway', 'ssh'],
        onDone,
      });
      click(radios(el, 'Over SSH')[0]);
      await flush();
      typeInto(el.querySelector('input[placeholder="user@host"]') as HTMLInputElement, 'me@box');
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Continue'));
      await flush(3);
      expect(testGatewayConnection).toHaveBeenCalledWith({
        dataDir: undefined,
        destination: 'me@box',
        kind: 'ssh',
      });

      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Continue'));
      await flush();
      const remoteRow = radios(el, 'Remote space')[0];
      click(remoteRow);
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Connect'));
      await flush(3);
      expect(sshConnectGateway).toHaveBeenCalledWith({
        dataDir: undefined,
        destination: 'me@box',
        label: undefined,
        rememberDevice: false,
        vault: { kind: 'existing', vaultId: 'r1' },
      });
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: 'Remote space',
        gatewayId: 'gwssh',
        vaultId: 'r1',
      });
    });

    it('a failed commit lands on the error step with a Retry that re-attempts', async () => {
      testGatewayConnection.mockResolvedValue({
        ok: true,
        stages: [],
        vaults: [{ name: 'A', vaultId: 'a' }],
      });
      sshConnectGateway.mockRejectedValueOnce(new Error('host unreachable'));
      sshConnectGateway.mockResolvedValueOnce({
        gatewayId: 'gw',
        ok: true,
        vaultId: 'a',
        vaultName: 'A',
      });
      const onDone = vi.fn<ConnectFlowProps['onDone']>();
      const el = mount({ context: 'switcher', methods: ['ssh'], onDone });
      click(radios(el, 'Over SSH')[0]);
      await flush();
      typeInto(el.querySelector('input[placeholder="user@host"]') as HTMLInputElement, 'me@box');
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Continue'));
      await flush(3);
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Continue'));
      await flush();
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Connect'));
      await flush(3);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain('host unreachable');

      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Retry'));
      await flush(3);
      expect(onDone).toHaveBeenCalledWith({
        displayLabel: 'A',
        gatewayId: 'gw',
        vaultId: 'a',
      });
    });

    it('"Start over" fires onCancel when supplied', () => {
      const onCancel = vi.fn<NonNullable<ConnectFlowProps['onCancel']>>();
      const el = mount({
        context: 'onboarding',
        onCancel,
        onDone: vi.fn<ConnectFlowProps['onDone']>(),
      });
      click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Start over'));
      expect(onCancel).toHaveBeenCalledOnce();
    });
  });
});
