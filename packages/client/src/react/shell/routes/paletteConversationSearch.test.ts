import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPaletteConversationSearch } from './paletteConversationSearch.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createPaletteConversationSearch', () => {
  it('debounces, caches, and notifies when results arrive', async () => {
    const search = vi.fn(async (q: string) => [{ id: `${q}-1`, title: q, snippet: '⟦x⟧' }]);
    const onResults = vi.fn();
    const src = createPaletteConversationSearch({ search, onResults, debounceMs: 100 });

    // Nothing cached yet.
    expect(src.results('budget')).toEqual([]);
    src.ensure('budget');
    src.ensure('budget'); // coalesced
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenCalledTimes(1);
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(src.results('budget')).toEqual([{ id: 'budget-1', title: 'budget', snippet: '⟦x⟧' }]);

    // A second ensure for the same (now cached) query is a no-op.
    src.ensure('budget');
    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('ignores queries shorter than two characters', () => {
    const search = vi.fn();
    const src = createPaletteConversationSearch({ search, onResults: () => undefined });
    src.ensure('b');
    vi.advanceTimersByTime(500);
    expect(search).not.toHaveBeenCalled();
    expect(src.results('b')).toEqual([]);
  });

  it('caches empty on failure and reset() clears everything', async () => {
    const search = vi.fn(async () => {
      throw new Error('nope');
    });
    const onResults = vi.fn();
    const src = createPaletteConversationSearch({ search, onResults, debounceMs: 50 });
    src.ensure('trip');
    await vi.advanceTimersByTimeAsync(50);
    expect(src.results('trip')).toEqual([]);
    expect(onResults).toHaveBeenCalled();
    src.reset();
    // After reset the same query fetches again.
    src.ensure('trip');
    await vi.advanceTimersByTimeAsync(50);
    expect(search).toHaveBeenCalledTimes(2);
  });
});
