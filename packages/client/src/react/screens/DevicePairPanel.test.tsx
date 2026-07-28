import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DevicePairPanel from './DevicePairPanel.js';
import type { GatewayDeviceTicket, GatewayMember } from '../../gateway-client.js';

// "Pair a device for <person>" (#599 Decision 10). The picker is a LIST —
// existing people plus "New person…" — because free text is a revocation gap:
// "priya" beside "Priya" is a second member who survives "remove Priya" still
// holding live access.

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

const TICKET: GatewayDeviceTicket = {
  ticket: 'CENTRAID-TICKET-XYZ',
  memberId: 'mem_priya',
  memberLabel: 'Priya',
  grants: [{ vaultId: 'v1', vaultName: 'Personal', role: 'write' }],
  vaultId: 'v1',
  vaultName: 'Personal',
  expiresAt: new Date(NOW + 900_000).toISOString(),
  role: 'write',
};

const MEMBERS: GatewayMember[] = [
  {
    memberId: 'mem_me',
    label: 'You',
    createdAt: new Date(NOW).toISOString(),
    roles: [{ vaultId: 'v1', vaultName: 'Personal', role: 'admin' }],
    deviceCount: 1,
  },
  {
    memberId: 'mem_priya',
    label: 'Priya',
    createdAt: new Date(NOW).toISOString(),
    roles: [{ vaultId: 'v1', vaultName: 'Personal', role: 'write' }],
    deviceCount: 1,
  },
];

const SPACES = [
  { vaultId: 'v1', vaultName: 'Personal' },
  { vaultId: 'v2', vaultName: 'Family Photos' },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

async function mount(
  onCreateTicket: (input?: unknown) => Promise<GatewayDeviceTicket>,
): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <DevicePairPanel
        now={NOW}
        onCreateTicket={onCreateTicket}
        onClose={() => undefined}
        members={MEMBERS}
        currentMemberId="mem_me"
        spaces={SPACES}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function select(el: HTMLElement): HTMLSelectElement {
  return el.querySelector('select') as HTMLSelectElement;
}

async function pick(el: HTMLElement, value: string): Promise<void> {
  const node = select(el);
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

/** React tracks the last value it wrote, so a plain `.value =` looks like a no-op. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The role ladder for one space — scoped, since every grant row has all three. */
function roleButton(el: HTMLElement, space: string, label: string): HTMLButtonElement | undefined {
  const group = el.querySelector(`[aria-label="Role in ${space}"]`);
  return [...(group?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label);
}

async function checkSpace(el: HTMLElement, label: string): Promise<void> {
  const box = [...el.querySelectorAll('label')]
    .find((node) => node.textContent?.trim() === label)
    ?.querySelector('input');
  await act(async () => {
    (box as HTMLInputElement).click();
  });
}

async function generate(el: HTMLElement): Promise<void> {
  const btn = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Generate ticket',
  );
  await act(async () => {
    btn!.click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('DevicePairPanel', () => {
  it('offers existing people plus New person…, never a bare text field', async () => {
    const el = await mount(vi.fn().mockResolvedValue(TICKET));
    const options = [...select(el).options].map((option) => option.textContent);
    expect(options).toEqual(['Myself', 'Priya', 'New person…']);
    // Self-pair is the landing state, and it says what it grants.
    expect(el.textContent).toContain('your current access');
    expect(el.querySelector('input[type="text"]')).toBeNull();
  });

  it('self-pairs by sending neither a member nor grants', async () => {
    const onCreateTicket = vi.fn().mockResolvedValue(TICKET);
    const el = await mount(onCreateTicket);
    await generate(el);
    expect(onCreateTicket).toHaveBeenCalledWith({ ttlMinutes: 15 });
    expect(el.textContent).toContain('CENTRAID-TICKET-XYZ');
    // The issued ticket states whose it is and what it reaches.
    expect(el.textContent).toContain('Priya');
    expect(el.textContent).toContain('Personal · Member');
  });

  it('mints for an existing person with per-space grants', async () => {
    const onCreateTicket = vi.fn().mockResolvedValue(TICKET);
    const el = await mount(onCreateTicket);
    await pick(el, 'mem_priya');
    await checkSpace(el, 'Family Photos');
    // Viewer, not `read` — the ladder is stated in ownership words.
    await act(async () => roleButton(el, 'Family Photos', 'Viewer')!.click());
    await generate(el);
    expect(onCreateTicket).toHaveBeenCalledWith({
      ttlMinutes: 15,
      memberId: 'mem_priya',
      grants: [{ vaultId: 'v2', role: 'read' }],
    });
  });

  it('creates a new person by label, defaulting each space to Member', async () => {
    const onCreateTicket = vi.fn().mockResolvedValue(TICKET);
    const el = await mount(onCreateTicket);
    await pick(el, '__new__');
    await typeInto(el.querySelector('input[type="text"]') as HTMLInputElement, ' Arun ');
    await checkSpace(el, 'Personal');
    await generate(el);
    expect(onCreateTicket).toHaveBeenCalledWith({
      ttlMinutes: 15,
      newMemberLabel: 'Arun',
      grants: [{ vaultId: 'v1', role: 'write' }],
    });
  });

  it('refuses to mint an invite that reaches nothing', async () => {
    const onCreateTicket = vi.fn().mockResolvedValue(TICKET);
    const el = await mount(onCreateTicket);
    await pick(el, 'mem_priya');
    await generate(el);
    expect(onCreateTicket).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Choose at least one space');
  });

  it('reads role_above_own back as the ownership sentence it is', async () => {
    const el = await mount(
      vi
        .fn()
        .mockRejectedValue(
          new Error('mint pairing ticket: {"error":"role_above_own","message":"…"}'),
        ),
    );
    await generate(el);
    expect(el.textContent).toContain('pair a device for yourself at the access you already have');
  });

  it('reads not_admin back as the ownership sentence it is', async () => {
    const el = await mount(
      vi
        .fn()
        .mockRejectedValue(new Error('mint pairing ticket: {"error":"not_admin","message":"…"}')),
    );
    await pick(el, 'mem_priya');
    await checkSpace(el, 'Personal');
    await generate(el);
    expect(el.textContent).toContain('needs you to be an Owner');
  });
});
