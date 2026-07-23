import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startVisibilityTicker } from './visibility-ticker.js';

// Wakeup-hygiene fix (issue #528 Phase D): the 1s ticker must stop firing while
// the tab is hidden and catch up immediately on return. Driven with fake timers
// and a mockable document.visibilityState so it stays deterministic.

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
}

let teardown: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility('visible');
});

afterEach(() => {
  teardown?.();
  teardown = null;
  vi.useRealTimers();
});

describe('startVisibilityTicker', () => {
  it('ticks every second while visible', () => {
    const tick = vi.fn();
    teardown = startVisibilityTicker(tick);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('stops ticking while the tab is hidden', () => {
    const tick = vi.fn();
    teardown = startVisibilityTicker(tick);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));

    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(1); // no further fires while hidden
  });

  it('refreshes immediately and resumes when the tab becomes visible again', () => {
    const tick = vi.fn();
    teardown = startVisibilityTicker(tick);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(0);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(tick).toHaveBeenCalledTimes(1); // immediate catch-up on return

    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(3); // then resumes ticking
  });

  it('detaches the listener and clears the interval on teardown', () => {
    const tick = vi.fn();
    const stop = startVisibilityTicker(tick);
    stop();
    vi.advanceTimersByTime(5000);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(tick).toHaveBeenCalledTimes(0);
  });
});
