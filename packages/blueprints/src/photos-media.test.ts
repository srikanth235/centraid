// @vitest-environment jsdom
// eslint-disable-next-line typescript-eslint/ban-ts-comment -- browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (#406)
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../apps/photos/format.js', () => ({
  isVideoAsset: (asset: Record<string, unknown>) =>
    asset.kind === 'video' || String(asset.media_type ?? '').startsWith('video/'),
  isAudioAsset: (asset: Record<string, unknown>) =>
    asset.kind === 'audio' || String(asset.media_type ?? '').startsWith('audio/'),
}));

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

  test('uses posters for video grids and never pulls a media original', async () => {
    const { gridSrc } = await importFixture('../apps/photos/media.js');

    expect(
      gridSrc({
        kind: 'video',
        content_uri: '/centraid/_vault/blobs/original-video',
        poster_uri: '/centraid/_vault/blobs/poster',
      }),
    ).toBe('/centraid/_vault/blobs/poster');
    expect(
      gridSrc({
        kind: 'video',
        content_uri: '/centraid/_vault/blobs/original-video',
        poster_uri: null,
      }),
    ).toBeNull();
    expect(
      gridSrc({
        kind: 'audio',
        content_uri: '/centraid/_vault/blobs/original-audio',
      }),
    ).toBeNull();
  });

  test('renders duration and media-specific lightweight placeholders', async () => {
    const { durationLabel, fillTileMedia } = await importFixture('../apps/photos/media.js');
    expect(durationLabel(65)).toBe('1:05');
    expect(durationLabel(3_661)).toBe('1:01:01');
    expect(durationLabel(-1)).toBeNull();

    const video = document.createElement('div');
    fillTileMedia(video, { kind: 'video', poster_uri: null, duration_s: 65 });
    expect(video.classList.contains('is-placeholder')).toBe(true);
    expect(video.querySelector('.ph-tile-video-badge')).not.toBeNull();
    expect(video.querySelector('.ph-tile-duration')?.textContent).toBe('1:05');

    const audio = document.createElement('div');
    fillTileMedia(audio, { kind: 'audio', duration_s: 3_661 });
    expect(audio.querySelector('.ph-tile-audio-badge')).not.toBeNull();
    expect(audio.querySelector('.ph-tile-duration')?.textContent).toBe('1:01:01');
  });
});
