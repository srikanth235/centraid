import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectFlow, { type ConnectFlowProps } from './ConnectFlow.js';

vi.mock('../../../gateway-client.js', () => ({
  listVaults: () => listVaultsMock(),
}));

const listVaultsMock = vi.fn();
const getSettings = vi.fn();
const setActiveGateway = vi.fn();
const setActiveVault = vi.fn();
const createVault = vi.fn();
const redeemGatewayPairing = vi.fn();
const addGateway = vi.fn();
const testGatewayConnection = vi.fn();
const sshConnectGateway = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listVaultsMock.mockResolvedValue([{ vaultId: 'a', name: 'Personal', color: '#4E68DD' }]);
  getSettings.mockResolvedValue({ activeGatewayId: 'local' });
  setActiveGateway.mockResolvedValue({});
  setActiveVault.mockResolvedValue({});
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
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function click(el: Element | null | undefined): void {
  act(() => (el as HTMLButtonElement)?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function radios(el: HTMLElement, name: string): HTMLButtonElement[] {
  return [...el.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((b) =>
    b.textContent?.includes(name),
  );
}

describe('ConnectFlow', () => {
  it('renders all three method cards by default', () => {
    const el = mount({ context: 'onboarding', onDone: vi.fn() });
    expect(el.querySelectorAll('[role="radio"]').length).toBe(3);
    expect(el.textContent).toContain('This Mac');
    expect(el.textContent).toContain('Existing gateway');
    expect(el.textContent).toContain('Over SSH');
  });

  it('a switcher ConnectFlowModal-style caller can omit the "This Mac" card', () => {
    const el = mount({ context: 'switcher', methods: ['gateway', 'ssh'], onDone: vi.fn() });
    expect(el.querySelectorAll('[role="radio"]').length).toBe(2);
    expect(el.textContent).not.toContain('This Mac');
  });

  it('onboarding + "This Mac" with exactly one existing vault completes without another click', async () => {
    const onDone = vi.fn();
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
    const el = mount({ context: 'switcher', onDone: vi.fn() });
    click(radios(el, 'This Mac')[0]);
    await flush(3);
    expect(el.querySelector('[role="radiogroup"][aria-label="Space"]')).toBeTruthy();
    expect(setActiveVault).not.toHaveBeenCalled();
  });

  it('local: picking a different existing vault and committing calls setActiveVault + onDone', async () => {
    listVaultsMock.mockResolvedValue([
      { vaultId: 'a', name: 'Personal' },
      { vaultId: 'b', name: 'Work' },
    ]);
    const onDone = vi.fn();
    const el = mount({ context: 'switcher', onDone });
    click(radios(el, 'This Mac')[0]);
    await flush(3);
    const workRow = [...el.querySelectorAll('[role="radio"]')].find((r) =>
      r.textContent?.includes('Work'),
    );
    click(workRow);
    const connectBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Connect');
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
      { vaultId: 'a', name: 'Personal' },
      { vaultId: 'b', name: 'Work' },
    ]);
    const el = mount({ context: 'switcher', onDone: vi.fn() });
    click(radios(el, 'This Mac')[0]);
    await flush(3);
    const createRow = [...el.querySelectorAll('[role="radio"]')].find((r) =>
      r.textContent?.includes('Create new space'),
    );
    click(createRow);
    typeInto(el.querySelector('input[placeholder="Space name"]') as HTMLInputElement, 'Play');
    const connectBtn = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Connect');
    click(connectBtn);
    await flush(3);
    expect(createVault).toHaveBeenCalledWith({ name: 'Play' });
    expect(setActiveVault).toHaveBeenCalledWith({ vaultId: 'new1' });
  });

  it('gateway/ticket happy path: test decodes the ticket, vault is locked, commit redeems it', async () => {
    testGatewayConnection.mockResolvedValue({
      ok: true,
      stages: [{ detail: '', id: 'decode', label: 'Decode ticket', status: 'pass' }],
      ticket: { expiresAt: '2030-01-01T00:00:00Z', gatewayEndpointId: 'ep1', vaultName: 'Office' },
    });
    redeemGatewayPairing.mockResolvedValue({
      gatewayId: 'gw1',
      ok: true,
      vaultId: 'v1',
      vaultName: 'Office',
    });
    const onDone = vi.fn();
    const el = mount({ context: 'onboarding', onDone });
    click(radios(el, 'Existing gateway')[0]);
    await flush();
    typeInto(el.querySelector('textarea') as HTMLTextAreaElement, 'a-ticket');
    const continueBtn1 = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Continue',
    );
    click(continueBtn1);
    await flush(3);
    expect(testGatewayConnection).toHaveBeenCalledWith({ kind: 'ticket', ticket: 'a-ticket' });
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
    expect(redeemGatewayPairing).toHaveBeenCalledWith({ label: undefined, ticket: 'a-ticket' });
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
    const el = mount({ context: 'onboarding', onDone: vi.fn() });
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
    const onDone = vi.fn();
    const el = mount({ context: 'switcher', methods: ['gateway', 'ssh'], onDone });
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
    const remoteRow = [...el.querySelectorAll('[role="radio"]')].find((r) =>
      r.textContent?.includes('Remote space'),
    );
    click(remoteRow);
    click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Connect'));
    await flush(3);
    expect(sshConnectGateway).toHaveBeenCalledWith({
      dataDir: undefined,
      destination: 'me@box',
      label: undefined,
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
    const onDone = vi.fn();
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
    expect(onDone).toHaveBeenCalledWith({ displayLabel: 'A', gatewayId: 'gw', vaultId: 'a' });
  });

  it('"Start over" fires onCancel when supplied', () => {
    const onCancel = vi.fn();
    const el = mount({ context: 'onboarding', onCancel, onDone: vi.fn() });
    click([...el.querySelectorAll('button')].find((b) => b.textContent === 'Start over'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
