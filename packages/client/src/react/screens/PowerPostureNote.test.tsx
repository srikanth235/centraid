import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import PowerPostureNote from './PowerPostureNote.js';
import type { PowerContextState } from './resource-summary.js';

// Power-context posture note (issue #528 Phase D): battery/thermal chrome only
// when the gateway host has a battery; a mains/server host shows a CPU-steal
// fact or nothing. Copy is attributed to the gateway HOST, never the viewer.

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function base(overrides: Partial<PowerContextState>): PowerContextState {
  return {
    kind: 'battery',
    battery: { percent: 62, charging: false },
    deferringBackgroundWork: false,
    reason: null,
    source: 'os-probe',
    stealPercent: null,
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function mount(power: PowerContextState): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<PowerPostureNote power={power} />);
  });
  return container;
}

describe('PowerPostureNote — battery host', () => {
  it('renders the on-battery deferral copy', async () => {
    const el = await mount(base({ deferringBackgroundWork: true, reason: 'on-battery' }));
    expect(el.querySelector('[data-testid="power-posture"]')?.textContent).toContain(
      'On battery — heavy background work deferred',
    );
  });

  it('renders the low-battery copy', async () => {
    const el = await mount(
      base({
        battery: { percent: 8, charging: false },
        deferringBackgroundWork: true,
        reason: 'low-battery',
      }),
    );
    expect(el.textContent).toContain('Battery low — background work paused until charging');
  });

  it('renders the thermal copy', async () => {
    const el = await mount(base({ deferringBackgroundWork: true, reason: 'thermal' }));
    expect(el.textContent).toContain('Thermal pressure — backing off');
  });

  it('attributes the posture to the gateway host, not the viewer', async () => {
    const el = await mount(base({ deferringBackgroundWork: true, reason: 'on-battery' }));
    expect(el.textContent).toContain('gateway’s host');
    expect(el.textContent?.toLowerCase()).not.toContain('you are on battery');
  });

  it('renders nothing when a battery host is idle (not deferring)', async () => {
    const el = await mount(base({ deferringBackgroundWork: false, reason: null }));
    expect(el.querySelector('[data-testid="power-posture"]')).toBeNull();
    expect(el.textContent).toBe('');
  });
});

describe('PowerPostureNote — no battery (mains / server)', () => {
  it('renders the server CPU-steal fact when steal ≥ 5%', async () => {
    const el = await mount(
      base({ kind: 'server', battery: null, stealPercent: 12, source: 'os-probe' }),
    );
    const note = el.querySelector('[data-testid="power-posture"]');
    expect(note?.textContent).toContain('Shared host: 12% CPU steal observed');
    expect(note?.textContent).toContain('the share you actually get');
  });

  it('renders nothing on a server host with steal below the 5% threshold', async () => {
    const el = await mount(base({ kind: 'server', battery: null, stealPercent: 3 }));
    expect(el.querySelector('[data-testid="power-posture"]')).toBeNull();
  });

  it('never renders battery/thermal chrome on a mains host, even when deferring', async () => {
    const el = await mount(
      base({ kind: 'mains', battery: null, deferringBackgroundWork: true, reason: 'thermal' }),
    );
    expect(el.querySelector('[data-testid="power-posture"]')).toBeNull();
    expect(el.textContent?.toLowerCase()).not.toContain('battery');
    expect(el.textContent?.toLowerCase()).not.toContain('thermal');
  });
});
