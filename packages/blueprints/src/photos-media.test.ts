// @vitest-environment jsdom
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (#406)
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const importFixture = (relativePath: string) => import(relativePath);

interface FakeObserver {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
}

const observers: FakeObserver[] = [];
let mutationCallback: MutationCallback | undefined;

describe('Photos next-screen media loading', () => {
  beforeEach(() => {
    vi.resetModules();
    observers.length = 0;
    mutationCallback = undefined;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  class FakeIntersectionObserver {
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();

    constructor(
      readonly callback: IntersectionObserverCallback,
      readonly options: IntersectionObserverInit,
    ) {
      observers.push(this);
    }
  }

  function FakeMutationObserver(callback: MutationCallback) {
    mutationCallback = callback;
    this.observe = vi.fn();
  }

  beforeEach(() => {
    vi.stubGlobal(
      'IntersectionObserver',
      FakeIntersectionObserver as unknown as typeof IntersectionObserver,
    );
    vi.stubGlobal('MutationObserver', FakeMutationObserver as unknown as typeof MutationObserver);
  });

  test('roots the one-screen lookahead in the overflowing photo pane', async () => {
    const { observeNextScreen } = await importFixture('../apps/photos/media-observer.js');
    const scrollPane = document.createElement('div');
    scrollPane.style.overflowY = 'auto';
    const tile = document.createElement('div');
    const image = document.createElement('img');
    tile.append(image);
    scrollPane.append(tile);
    document.body.append(scrollPane);

    observeNextScreen(image, '/centraid/_vault/blobs/photo?variant=thumb');

    expect(observers).toHaveLength(1);
    expect(observers[0]?.options).toMatchObject({ root: scrollPane, rootMargin: '100% 0px' });
    expect(observers[0]?.observe).toHaveBeenCalledWith(image);
    expect(image.getAttribute('src')).toBeNull();

    observers[0]?.callback(
      [{ isIntersecting: true, target: image } as IntersectionObserverEntry],
      observers[0] as unknown as IntersectionObserver,
    );
    expect(image.getAttribute('src')).toBe('/centraid/_vault/blobs/photo?variant=thumb');
    expect(observers[0]?.unobserve).toHaveBeenCalledWith(image);
  });

  test('keeps observers scoped per scroll container and releases detached tiles', async () => {
    const { observeNextScreen } = await importFixture('../apps/photos/media-observer.js');
    const roots = [document.createElement('div'), document.createElement('div')];
    const tiles = roots.map((root) => {
      root.style.overflowY = 'auto';
      const tile = document.createElement('div');
      const image = document.createElement('img');
      tile.append(image);
      root.append(tile);
      document.body.append(root);
      observeNextScreen(image, 'data:image/png;base64,AA==');
      return { tile, image };
    });

    expect(observers).toHaveLength(2);
    expect(observers[0]?.options.root).toBe(roots[0]);
    expect(observers[1]?.options.root).toBe(roots[1]);

    tiles[0]?.tile.remove();
    mutationCallback?.(
      [{ removedNodes: [tiles[0]?.tile] } as unknown as MutationRecord],
      {} as MutationObserver,
    );
    expect(observers[1]?.unobserve).not.toHaveBeenCalled();
    expect(observers[0]?.unobserve).toHaveBeenCalledWith(tiles[0]?.image);
  });
});
