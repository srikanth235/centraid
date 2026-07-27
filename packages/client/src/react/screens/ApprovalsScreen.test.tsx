// governance: allow-repo-hygiene file-size-limit (#552) one suite per screen — decision/risk/actor/grant/collapse/filter/expand cases all exercise the single ApprovalsScreen activity contract and share its mount fixtures
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalsScreen, {
  type ApprovalsActivityRowDTO,
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
  caller: 'gmail-send',
  callerKind: 'agent',
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
  caller: 'Briefing',
  callerKind: 'app',
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

function activityRow(over: Partial<ApprovalsActivityRowDTO> = {}): ApprovalsActivityRowDTO {
  return {
    receiptId: 'receipt-1',
    label: 'Sync remove connection',
    detail: 'agent.command · cmd-abc…',
    objectId: 'cmd-abc123def456',
    objectType: 'agent.command',
    occurredAgo: '12m ago',
    occurredAt: '2026-03-01T12:00:00.000Z',
    decision: 'allow',
    risk: null,
    actor: 'gmail-send',
    actorKind: 'agent',
    grantId: null,
    attribution: 'owner',
    count: 1,
    action: 'act sync.remove_connection',
    ...over,
  };
}

const fillActivity = activityRow({
  receiptId: 'receipt-fill',
  label: 'Locker filled a login',
  detail: 'https://example.test',
  objectId: 'login-1',
  objectType: 'locker.item',
  occurredAgo: '1m ago',
  decision: 'allow',
  actor: null,
  actorKind: null,
  attribution: 'owner',
  action: 'reveal',
});

function makeProps(over: Partial<ApprovalsScreenProps> = {}): ApprovalsScreenProps {
  return {
    outbox: [],
    needsAuth: [],
    parked: [],
    scopeRequests: [],
    grants: [],
    activity: [],
    busyId: null,
    onApproveOutbox: vi.fn<ApprovalsScreenProps['onApproveOutbox']>(),
    onDenyOutbox: vi.fn<ApprovalsScreenProps['onDenyOutbox']>(),
    onOpenSettings: vi.fn<ApprovalsScreenProps['onOpenSettings']>(),
    onConfirmParked: vi.fn<ApprovalsScreenProps['onConfirmParked']>(),
    onDecideScopeRequest: vi.fn<ApprovalsScreenProps['onDecideScopeRequest']>(),
    onRevokeGrant: vi.fn<ApprovalsScreenProps['onRevokeGrant']>(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
describe('screens/ApprovalsScreen', () => {
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

  describe(ApprovalsScreen, () => {
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
      const onApproveOutbox = vi.fn<ApprovalsScreenProps['onApproveOutbox']>();
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
      const onDenyOutbox = vi.fn<ApprovalsScreenProps['onDenyOutbox']>();
      const el = mount(makeProps({ outbox: [outboxRow], onDenyOutbox }));
      act(() => {
        findButton(el, 'Hi').click();
      });
      act(() => {
        findButton(el, 'Deny').click();
      });
      expect(onDenyOutbox).toHaveBeenCalledWith('item1');
    });

    it('shows an Automation badge and the display name for an agent-kind outbox caller', () => {
      const el = mount(makeProps({ outbox: [outboxRow] }));
      expect(el.textContent).toContain('Automation');
      expect(el.textContent).toContain('gmail-send');
    });

    it('shows an Assistant badge for an assistant-kind outbox caller', () => {
      const el = mount(
        makeProps({ outbox: [{ ...outboxRow, caller: 'Assistant', callerKind: 'assistant' }] }),
      );
      expect(el.textContent).toContain('Assistant');
    });

    it('shows an App badge for an app-kind outbox caller', () => {
      const el = mount(
        makeProps({ outbox: [{ ...outboxRow, caller: 'Briefing', callerKind: 'app' }] }),
      );
      expect(el.textContent).toContain('App');
      expect(el.textContent).toContain('Briefing');
    });

    it('shows no kind badge for an owner-staged outbox item, but still shows the caller name', () => {
      const el = mount(
        makeProps({ outbox: [{ ...outboxRow, caller: 'owner', callerKind: 'owner' }] }),
      );
      expect(el.querySelector('[data-kind]')).toBeNull();
      expect(el.textContent).not.toContain('Automation');
      expect(el.textContent).toContain('owner');
    });

    it('routes needs-auth reconnection through onOpenSettings', () => {
      const onOpenSettings = vi.fn<ApprovalsScreenProps['onOpenSettings']>();
      const el = mount(makeProps({ needsAuth: [needsAuthRow], onOpenSettings }));
      act(() => {
        findButton(el, 'Reconnect').click();
      });
      expect(onOpenSettings).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
    });

    it('fires onConfirmParked(true) on Approve without needing to expand first', () => {
      const onConfirmParked = vi.fn<ApprovalsScreenProps['onConfirmParked']>();
      const el = mount(makeProps({ parked: [parkedRow], onConfirmParked }));
      act(() => {
        findButton(el, 'social.send_message').click();
      });
      act(() => {
        findButton(el, 'Approve').click();
      });
      expect(onConfirmParked).toHaveBeenCalledWith('inv1', true);
    });

    it('shows an App badge and the display name for an app-kind parked caller', () => {
      const el = mount(makeProps({ parked: [parkedRow] }));
      expect(el.textContent).toContain('App');
      expect(el.textContent).toContain('Briefing');
    });

    it('shows an Automation badge for an agent-kind parked caller (automations ride the agent plane)', () => {
      const el = mount(
        makeProps({
          parked: [{ ...parkedRow, caller: 'E2e Agent Purge Demo', callerKind: 'agent' }],
        }),
      );
      expect(el.textContent).toContain('Automation');
      expect(el.textContent).toContain('E2e Agent Purge Demo');
    });

    it('shows an Assistant badge for an assistant-kind parked caller, distinct from an automation', () => {
      const el = mount(
        makeProps({ parked: [{ ...parkedRow, caller: 'Assistant', callerKind: 'assistant' }] }),
      );
      expect(el.textContent).toContain('Assistant');
      expect(el.textContent).not.toContain('Automation');
    });

    it('fires onDecideScopeRequest inline (no expansion needed)', () => {
      const onDecideScopeRequest = vi.fn<ApprovalsScreenProps['onDecideScopeRequest']>();
      const el = mount(makeProps({ scopeRequests: [scopeRow], onDecideScopeRequest }));
      act(() => {
        findButton(el, 'Deny').click();
      });
      expect(onDecideScopeRequest).toHaveBeenCalledWith('r1', false);
    });

    it('renders standing grants with a Revoke action', () => {
      const onRevokeGrant = vi.fn<ApprovalsScreenProps['onRevokeGrant']>();
      const el = mount(makeProps({ grants: [grantRow], onRevokeGrant }));
      expect(el.textContent).toContain('gmail-send');
      expect(el.textContent).toContain('ravi@example.com');
      act(() => {
        findButton(el, 'Revoke').click();
      });
      expect(onRevokeGrant).toHaveBeenCalledWith('g1');
    });

    it('shows the origin of a recent Locker fill in review activity', () => {
      const el = mount(makeProps({ activity: [fillActivity] }));
      expect(el.textContent).toContain('Recent activity');
      expect(el.textContent).toContain('Locker filled a login');
      expect(el.textContent).toContain('https://example.test');
    });

    it('renders a distinct decision badge + icon accent per decision value', () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({ receiptId: 'a1', decision: 'allow', label: 'Allowed act' }),
            activityRow({ receiptId: 'a2', decision: 'deny', label: 'Denied act' }),
          ],
        }),
      );
      const badges = [...el.querySelectorAll('[data-testid="activity-decision-badge"]')].map(
        (n) => n.textContent,
      );
      expect(badges).toStrictEqual(expect.arrayContaining(['Allowed', 'Denied']));
      const allowRow = el.querySelector('[data-decision="allow"]');
      const denyRow = el.querySelector('[data-decision="deny"]');
      expect(allowRow).not.toBeNull();
      expect(denyRow).not.toBeNull();
      expect(allowRow?.className).not.toBe(denyRow?.className);
      expect(allowRow?.querySelector('[data-testid="activity-decision-icon"]')).not.toBeNull();
      expect(denyRow?.querySelector('[data-testid="activity-decision-icon"]')).not.toBeNull();
    });

    it('shows a risk salience marker only when risk is non-null', () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({ receiptId: 'r1', risk: 'high', label: 'Risky' }),
            activityRow({ receiptId: 'r2', risk: null, label: 'Quiet' }),
          ],
        }),
      );
      expect(el.querySelectorAll('[data-testid="activity-risk-marker"]')).toHaveLength(1);
      expect(el.querySelector('[data-risk="high"]')).not.toBeNull();
    });

    it('shows an actor KindBadge matching Outbox treatment per actorKind', () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              receiptId: 'app1',
              actor: 'Briefing',
              actorKind: 'app',
              label: 'App act',
            }),
            activityRow({
              receiptId: 'ag1',
              actor: 'gmail-send',
              actorKind: 'agent',
              label: 'Agent act',
            }),
            activityRow({
              receiptId: 'as1',
              actor: 'Assistant',
              actorKind: 'assistant',
              label: 'Assistant act',
            }),
          ],
        }),
      );
      expect(el.textContent).toContain('App');
      expect(el.textContent).toContain('Briefing');
      expect(el.textContent).toContain('Automation');
      expect(el.textContent).toContain('gmail-send');
      expect(el.textContent).toContain('Assistant');
    });

    it('attributes standing-grant auto-allow and fires onRevokeGrant from the activity row', () => {
      const onRevokeGrant = vi.fn<ApprovalsScreenProps['onRevokeGrant']>();
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              receiptId: 'g-row',
              grantId: 'grant-42',
              attribution: 'grant',
              decision: 'allow',
              label: 'Auto send',
            }),
          ],
          onRevokeGrant,
        }),
      );
      expect(el.querySelector('[data-testid="activity-attribution-grant"]')?.textContent).toContain(
        'Auto-allowed by standing grant',
      );
      act(() => {
        findButton(el, 'Auto send').click();
      });
      act(() => {
        findButton(el, 'Revoke grant').click();
      });
      expect(onRevokeGrant).toHaveBeenCalledWith('grant-42');
    });

    it('says approved-by-the-owner when attribution is owner', () => {
      const el = mount(
        makeProps({
          activity: [activityRow({ attribution: 'owner', decision: 'allow', label: 'Owner ok' })],
        }),
      );
      expect(el.querySelector('[data-testid="activity-attribution-owner"]')?.textContent).toContain(
        'Approved by the owner',
      );
    });

    it('shows a ×N marker for collapsed adjacent duplicates', () => {
      const el = mount(
        makeProps({
          activity: [activityRow({ count: 3, label: 'Draft drop', receiptId: 'collapsed' })],
        }),
      );
      expect(el.querySelector('[data-testid="activity-count"]')?.textContent).toBe('×3');
    });

    it('expands an activity row to the full object id and absolute time', () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({
              label: 'Remove connection',
              objectId: 'cmd-abc123def456',
              objectType: 'agent.command',
              occurredAt: '2026-03-01T12:00:00.000Z',
            }),
          ],
        }),
      );
      expect(el.querySelector('[data-testid="activity-detail"]')).toBeNull();
      act(() => {
        findButton(el, 'Remove connection').click();
      });
      const detail = el.querySelector('[data-testid="activity-detail"]');
      expect(detail).not.toBeNull();
      expect(detail?.textContent).toContain('cmd-abc123def456');
      expect(detail?.textContent).toContain('agent.command');
      // Absolute timestamp is reachable in the expanded panel.
      expect(detail?.textContent).toMatch(/2026|Mar|03/);
    });

    it('filters to Denied-only when the Denied chip is active', () => {
      const el = mount(
        makeProps({
          activity: [
            activityRow({ receiptId: 'ok', decision: 'allow', label: 'Allowed row' }),
            activityRow({ receiptId: 'no', decision: 'deny', label: 'Denied row' }),
          ],
        }),
      );
      expect(el.textContent).toContain('Allowed row');
      expect(el.textContent).toContain('Denied row');
      act(() => {
        (el.querySelector('[data-testid="activity-filter-denied"]') as HTMLButtonElement).click();
      });
      expect(el.textContent).not.toContain('Allowed row');
      expect(el.textContent).toContain('Denied row');
    });

    it('shows See all when the feed is truncated and fires onSeeAllActivity', () => {
      const onSeeAllActivity = vi.fn<NonNullable<ApprovalsScreenProps['onSeeAllActivity']>>();
      const el = mount(
        makeProps({
          activity: [activityRow()],
          activityTruncated: true,
          onSeeAllActivity,
        }),
      );
      expect(el.querySelector('[data-testid="activity-see-all"]')).not.toBeNull();
      act(() => {
        findButton(el, 'See all').click();
      });
      expect(onSeeAllActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
    });

    it('does not show See all when the feed is not truncated', () => {
      const el = mount(makeProps({ activity: [activityRow()], activityTruncated: false }));
      expect(el.querySelector('[data-testid="activity-see-all"]')).toBeNull();
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
      const onApproveOutbox = vi.fn<ApprovalsScreenProps['onApproveOutbox']>();
      const el = mount(makeProps({ outbox: [editableOutboxRow], onApproveOutbox }));
      act(() => {
        findButton(el, 'Hi').click();
      });
      act(() => {
        findButton(el, 'Edit').click();
      });
      const setNativeValue = (
        input: HTMLInputElement | HTMLTextAreaElement,
        value: string,
      ): void => {
        const proto =
          input instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        setter?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      act(() => {
        setNativeValue(
          el.querySelector('input[aria-label="Subject"]') as HTMLInputElement,
          'New subject',
        );
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
      const onApproveOutbox = vi.fn<ApprovalsScreenProps['onApproveOutbox']>();
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
      const onApproveOutbox = vi.fn<ApprovalsScreenProps['onApproveOutbox']>();
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
});
