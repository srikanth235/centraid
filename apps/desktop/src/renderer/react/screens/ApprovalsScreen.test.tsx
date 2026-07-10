import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalsScreen, {
  type ApprovalsGrantRowDTO,
  type ApprovalsNeedsAuthRowDTO,
  type ApprovalsOutboxRowDTO,
  type ApprovalsParkedRowDTO,
  type ApprovalsScopeRequestRowDTO,
  type ApprovalsScreenProps,
} from './ApprovalsScreen.js';

const outboxRow: ApprovalsOutboxRowDTO = {
  itemId: 'item1',
  connectionLabel: 'personal',
  connectionKind: 'pull.gmail',
  verb: 'gmail.send',
  target: 'ravi@example.com',
  recipient: 'ravi@example.com',
  subject: 'Hi',
  bodyPreview: 'See you at 6.',
  fields: [
    { key: 'to', label: 'To', value: 'ravi@example.com' },
    { key: 'subject', label: 'Subject', value: 'Hi' },
    { key: 'body', label: 'Body', value: 'See you at 6.' },
  ],
  stagedAgo: '5m ago',
  note: null,
  canEdit: false,
  artifact: { to: 'ravi@example.com', subject: 'Hi', body: 'See you at 6.' },
};

const editableOutboxRow: ApprovalsOutboxRowDTO = {
  ...outboxRow,
  canEdit: true,
  fields: [
    { key: 'to', label: 'To', value: 'ravi@example.com, asha@example.com' },
    { key: 'subject', label: 'Subject', value: 'Hi' },
    { key: 'body', label: 'Body', value: 'See you at 6.' },
  ],
  artifact: { to: ['ravi@example.com', 'asha@example.com'], subject: 'Hi', body: 'See you at 6.' },
};

const needsAuthRow: ApprovalsNeedsAuthRowDTO = {
  connectionId: 'c1',
  label: 'work gmail',
  kind: 'pull.gmail',
  note: 'token expired',
};

const parkedRow: ApprovalsParkedRowDTO = {
  invocationId: 'inv1',
  command: 'social.send_message',
  caller: 'assistant',
  parkedAgo: '2m ago',
  inputPreview: '{\n  "to": "x"\n}',
};

const scopeRow: ApprovalsScopeRequestRowDTO = {
  requestId: 'r1',
  appId: 'invoicer',
  purpose: 'dpv:ServiceProvision',
  scopeSummary: 'business.invoice (act)',
  requestedAgo: '1h ago',
};

const grantRow: ApprovalsGrantRowDTO = {
  grantId: 'g1',
  actorLabel: 'gmail-send',
  verb: 'gmail.send',
  target: 'ravi@example.com',
  createdAgo: '3d ago',
};

function makeProps(over: Partial<ApprovalsScreenProps> = {}): ApprovalsScreenProps {
  return {
    outbox: [],
    needsAuth: [],
    parked: [],
    scopeRequests: [],
    grants: [],
    busyId: null,
    onApproveOutbox: vi.fn(),
    onDenyOutbox: vi.fn(),
    onOpenSettings: vi.fn(),
    onConfirmParked: vi.fn(),
    onDecideScopeRequest: vi.fn(),
    onRevokeGrant: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});
function mount(props: ApprovalsScreenProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<ApprovalsScreen {...props} />);
  });
  return container;
}
function findButton(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`no button with text "${text}"`);
  return btn as HTMLButtonElement;
}

describe('ApprovalsScreen', () => {
  it('shows the honest empty state when nothing is waiting, but still renders the grants section', () => {
    const el = mount(makeProps());
    expect(el.textContent).toContain('Nothing waiting on you.');
    expect(el.textContent).toContain('Standing grants');
    expect(el.textContent).toContain('No standing grants yet');
  });

  it('groups the inbox by kind with counts', () => {
    const el = mount(
      makeProps({
        outbox: [outboxRow],
        needsAuth: [needsAuthRow],
        parked: [parkedRow],
        scopeRequests: [scopeRow],
      }),
    );
    expect(el.textContent).toContain('Outbox');
    expect(el.textContent).toContain('Needs auth');
    expect(el.textContent).toContain('Parked');
    expect(el.textContent).toContain('Scope requests');
    expect(el.textContent).toContain('4 waiting on you');
  });

  it('expands an outbox row on click to reveal the readable artifact fields + actions', () => {
    const el = mount(makeProps({ outbox: [outboxRow] }));
    expect(el.textContent).not.toContain('See you at 6.');
    act(() => {
      findButton(el, 'Hi').click();
    });
    expect(el.textContent).toContain('See you at 6.');
    expect(el.querySelector('.editNote')?.textContent).toContain('can’t be edited yet');
  });

  it('fires onApproveOutbox with the always-allow checkbox state', () => {
    const onApproveOutbox = vi.fn();
    const el = mount(makeProps({ outbox: [outboxRow], onApproveOutbox }));
    act(() => {
      findButton(el, 'Hi').click();
    });
    const checkbox = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => {
      checkbox.click();
    });
    act(() => {
      findButton(el, 'Approve').click();
    });
    expect(onApproveOutbox).toHaveBeenCalledWith('item1', true);
  });

  it('fires onDenyOutbox for the expanded item', () => {
    const onDenyOutbox = vi.fn();
    const el = mount(makeProps({ outbox: [outboxRow], onDenyOutbox }));
    act(() => {
      findButton(el, 'Hi').click();
    });
    act(() => {
      findButton(el, 'Deny').click();
    });
    expect(onDenyOutbox).toHaveBeenCalledWith('item1');
  });

  it('routes needs-auth reconnection through onOpenSettings', () => {
    const onOpenSettings = vi.fn();
    const el = mount(makeProps({ needsAuth: [needsAuthRow], onOpenSettings }));
    act(() => {
      findButton(el, 'Reconnect').click();
    });
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('fires onConfirmParked(true) on Approve without needing to expand first', () => {
    const onConfirmParked = vi.fn();
    const el = mount(makeProps({ parked: [parkedRow], onConfirmParked }));
    act(() => {
      findButton(el, 'social.send_message').click();
    });
    act(() => {
      findButton(el, 'Approve').click();
    });
    expect(onConfirmParked).toHaveBeenCalledWith('inv1', true);
  });

  it('fires onDecideScopeRequest inline (no expansion needed)', () => {
    const onDecideScopeRequest = vi.fn();
    const el = mount(makeProps({ scopeRequests: [scopeRow], onDecideScopeRequest }));
    act(() => {
      findButton(el, 'Deny').click();
    });
    expect(onDecideScopeRequest).toHaveBeenCalledWith('r1', false);
  });

  it('renders standing grants with a Revoke action', () => {
    const onRevokeGrant = vi.fn();
    const el = mount(makeProps({ grants: [grantRow], onRevokeGrant }));
    expect(el.textContent).toContain('gmail-send');
    expect(el.textContent).toContain('ravi@example.com');
    act(() => {
      findButton(el, 'Revoke').click();
    });
    expect(onRevokeGrant).toHaveBeenCalledWith('g1');
  });

  it('shows an Edit affordance only when canEdit is true, and keeps the honest copy otherwise', () => {
    const notEditable = mount(makeProps({ outbox: [outboxRow] }));
    act(() => {
      findButton(notEditable, 'Hi').click();
    });
    expect(() => findButton(notEditable, 'Edit')).toThrow();
    expect(notEditable.querySelector('.editNote')?.textContent).toContain('can’t be edited yet');

    const editable = mount(makeProps({ outbox: [editableOutboxRow] }));
    act(() => {
      findButton(editable, 'Hi').click();
    });
    expect(() => findButton(editable, 'Edit')).not.toThrow();
    expect(editable.querySelector('.editNote')).toBeNull();
  });

  it('edit mode turns string fields into inputs/textarea and the string[] field into a comma input, seeded with the staged values', () => {
    const el = mount(makeProps({ outbox: [editableOutboxRow] }));
    act(() => {
      findButton(el, 'Hi').click();
    });
    act(() => {
      findButton(el, 'Edit').click();
    });
    const toInput = el.querySelector('input[aria-label="To"]') as HTMLInputElement;
    const subjectInput = el.querySelector('input[aria-label="Subject"]') as HTMLInputElement;
    const bodyArea = el.querySelector('textarea[aria-label="Body"]') as HTMLTextAreaElement;
    expect(toInput.value).toBe('ravi@example.com, asha@example.com');
    expect(subjectInput.value).toBe('Hi');
    expect(bodyArea.value).toBe('See you at 6.');
    // Cancel and Approve with edits replace Edit/Approve while editing.
    expect(() => findButton(el, 'Cancel')).not.toThrow();
    expect(() => findButton(el, 'Approve with edits')).not.toThrow();
  });

  it('submits the edited artifact on "Approve with edits", splitting the recipients on comma', () => {
    const onApproveOutbox = vi.fn();
    const el = mount(makeProps({ outbox: [editableOutboxRow], onApproveOutbox }));
    act(() => {
      findButton(el, 'Hi').click();
    });
    act(() => {
      findButton(el, 'Edit').click();
    });
    const setNativeValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
      const proto =
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => {
      setNativeValue(el.querySelector('input[aria-label="Subject"]') as HTMLInputElement, 'New subject');
      setNativeValue(
        el.querySelector('textarea[aria-label="Body"]') as HTMLTextAreaElement,
        'New body.',
      );
      setNativeValue(
        el.querySelector('input[aria-label="To"]') as HTMLInputElement,
        'x@example.com, y@example.com',
      );
    });
    act(() => {
      findButton(el, 'Approve with edits').click();
    });
    expect(onApproveOutbox).toHaveBeenCalledWith('item1', false, {
      to: ['x@example.com', 'y@example.com'],
      subject: 'New subject',
      body: 'New body.',
    });
  });

  it('Cancel exits edit mode and restores the read-only fields, without approving', () => {
    const onApproveOutbox = vi.fn();
    const el = mount(makeProps({ outbox: [editableOutboxRow], onApproveOutbox }));
    act(() => {
      findButton(el, 'Hi').click();
    });
    act(() => {
      findButton(el, 'Edit').click();
    });
    act(() => {
      findButton(el, 'Cancel').click();
    });
    expect(el.querySelector('input[aria-label="Subject"]')).toBeNull();
    expect(el.textContent).toContain('See you at 6.');
    expect(onApproveOutbox).not.toHaveBeenCalled();
  });

  it('a plain Approve with no edits calls onApproveOutbox with just (itemId, alwaysAllow)', () => {
    const onApproveOutbox = vi.fn();
    const el = mount(makeProps({ outbox: [outboxRow], onApproveOutbox }));
    act(() => {
      findButton(el, 'Hi').click();
    });
    act(() => {
      findButton(el, 'Approve').click();
    });
    expect(onApproveOutbox).toHaveBeenCalledWith('item1', false);
  });

  it('disables the busy row’s actions', () => {
    const el = mount(makeProps({ outbox: [outboxRow], busyId: 'item1' }));
    act(() => {
      findButton(el, 'Hi').click();
    });
    expect(findButton(el, 'Approve').disabled).toBe(true);
    expect(findButton(el, 'Deny').disabled).toBe(true);
  });
});
