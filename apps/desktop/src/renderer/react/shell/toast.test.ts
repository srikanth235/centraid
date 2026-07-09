import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { showToast } from './toast.js';

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});
afterEach(() => {
  vi.useRealTimers();
});

describe('showToast', () => {
  it('mounts a global toast with the message and auto-dismisses after 2s', () => {
    showToast('Saved');
    const toast = document.querySelector('.global-toast');
    expect(toast?.textContent).toContain('Saved');
    expect(toast?.classList.contains('toast')).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(document.querySelector('.global-toast')).toBeNull();
  });

  it('replaces an existing toast rather than stacking', () => {
    showToast('one');
    showToast('two');
    const toasts = document.querySelectorAll('.global-toast');
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.textContent).toContain('two');
  });
});
