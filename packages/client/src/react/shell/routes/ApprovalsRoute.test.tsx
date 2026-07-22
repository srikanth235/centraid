import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellActions } from '../actions.js';

const getBlocking = vi.fn();
const listOutboxGrants = vi.fn();
const getReview = vi.fn();
const decideOutboxItem = vi.fn();
vi.mock('../../../gateway-client-outbox.js', () => ({
  getBlocking: () => getBlocking(),
  listOutboxGrants: () => listOutboxGrants(),
  getReview: () => getReview(),
  decideOutboxItem: (input: unknown) => decideOutboxItem(input),
  decideScopeRequest: vi.fn(),
  revokeOutboxGrant: vi.fn(),
}));
vi.mock('../../../gateway-client-vault.js', () => ({
  confirmVaultParked: vi.fn(),
}));

let ApprovalsRoute: typeof import('./ApprovalsRoute.js').default;
let ShellActionsProvider: typeof import('../actions.js').ShellActionsProvider;
let root: Root | null = null;
let host: HTMLElement | null = null;

const confirm = vi.fn().mockResolvedValue(true);
const showToast = vi.fn();
const navigate = vi.fn();

function makeActions(): ShellActions {
  return {
    showToast,
    builderEnabled: false,
    enterBuilder: vi.fn(),
    openNewAppSheet: vi.fn(),
    openCommandPalette: vi.fn(),
    openContextMenu: vi.fn(),
    confirm,
    navigate,
  };
}

beforeEach(async () => {
  ({ default: ApprovalsRoute } = await import('./ApprovalsRoute.js'));
  ({ ShellActionsProvider } = await import('../actions.js'));
  getBlocking.mockReset().mockResolvedValue({
    outbox: [],
    needsAuth: [],
    parked: [],
    scopeRequests: [],
  });
  listOutboxGrants.mockReset().mockResolvedValue([]);
  getReview.mockReset().mockResolvedValue([]);
  decideOutboxItem.mockReset();
  confirm.mockClear().mockResolvedValue(true);
  showToast.mockClear();
  navigate.mockClear();
});

async function render(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ShellActionsProvider value={makeActions()}>
        <ApprovalsRoute />
      </ShellActionsProvider>,
    );
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('ApprovalsRoute', () => {
  it('shows a loading state, then the empty state once the blocking inbox resolves empty', async () => {
    const el = await render();
    expect(el.textContent).toContain('Nothing waiting on you.');
  });

  it('surfaces a fetch error', async () => {
    getBlocking.mockRejectedValue(new Error('offline'));
    const el = await render();
    expect(el.querySelector('.pageEmpty')?.textContent).toContain('offline');
  });

  it('approves an outbox item and reloads the inbox', async () => {
    getBlocking.mockResolvedValueOnce({
      outbox: [
        {
          itemId: 'item1',
          connection: { kind: 'pull.gmail', label: 'personal' },
          actor: 'gmail-send',
          actorKind: 'ai_agent',
          verb: 'gmail.send',
          target: 'ravi@example.com',
          artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you at 6.' },
          status: 'pending',
          grantId: null,
          stagedAt: new Date().toISOString(),
          decidedAt: null,
          drainedAt: null,
          result: null,
          note: null,
          canEdit: false,
        },
      ],
      needsAuth: [],
      parked: [],
      scopeRequests: [],
    });
    getBlocking.mockResolvedValueOnce({
      outbox: [],
      needsAuth: [],
      parked: [],
      scopeRequests: [],
    });
    decideOutboxItem.mockResolvedValue({
      status: 'executed',
      invocationId: 'inv1',
      receiptId: 'rec1',
      output: { item_id: 'item1', status: 'approved' },
    });
    const el = await render();
    const subjectBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Hi'),
    ) as HTMLButtonElement;
    await act(async () => subjectBtn.click());
    const approveBtn = [...el.querySelectorAll('button')].find(
      (b) => b.textContent === 'Approve',
    ) as HTMLButtonElement;
    await act(async () => {
      approveBtn.click();
      await Promise.resolve();
    });
    expect(decideOutboxItem).toHaveBeenCalledWith({
      itemId: 'item1',
      decision: 'approve',
      alwaysAllow: false,
    });
    expect(getBlocking).toHaveBeenCalledTimes(2);
  });

  it('edits an editable outbox item and approves with the revised artifact', async () => {
    getBlocking.mockResolvedValueOnce({
      outbox: [
        {
          itemId: 'item1',
          connection: { kind: 'pull.gmail', label: 'personal' },
          actor: 'gmail-send',
          actorKind: 'ai_agent',
          verb: 'gmail.send',
          target: 'ravi@example.com',
          artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you at 6.' },
          status: 'pending',
          grantId: null,
          stagedAt: new Date().toISOString(),
          decidedAt: null,
          drainedAt: null,
          result: null,
          note: null,
          canEdit: true,
        },
      ],
      needsAuth: [],
      parked: [],
      scopeRequests: [],
    });
    getBlocking.mockResolvedValueOnce({
      outbox: [],
      needsAuth: [],
      parked: [],
      scopeRequests: [],
    });
    decideOutboxItem.mockResolvedValue({
      status: 'executed',
      invocationId: 'inv1',
      receiptId: 'rec1',
      output: { item_id: 'item1', status: 'approved' },
    });
    const el = await render();
    const findButton = (text: string): HTMLButtonElement =>
      [...el.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement;
    await act(async () => {
      [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Hi'))!.click();
    });
    await act(async () => {
      findButton('Edit').click();
    });
    const subjectInput = el.querySelector('input[aria-label="Subject"]') as HTMLInputElement;
    const setNativeValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setNativeValue(subjectInput, 'Edited subject');
    });
    await act(async () => {
      findButton('Approve with edits').click();
      await Promise.resolve();
    });
    expect(decideOutboxItem).toHaveBeenCalledWith({
      itemId: 'item1',
      decision: 'approve',
      alwaysAllow: false,
      artifact: { to: 'ravi@example.com', subject: 'Edited subject', body: 'See you at 6.' },
    });
    expect(getBlocking).toHaveBeenCalledTimes(2);
  });
});
