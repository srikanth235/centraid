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

  // Issue #599. The shell's blob authorizer resolves a `/centraid/_vault/blobs/…`
  // reference in the scope named by the element's own `data-scope` or its
  // nearest ancestor's. Content ids are minted per scope and collide across
  // scopes by design, so a tile painted for an audience WITHOUT the attribute
  // does not 404 — it renders a different photo. The stamp therefore has to
  // land on the tile before the media element exists, which is also what makes
  // it cover the `data-prefetch-src` the lazy loader stages there.
  test('stamps the owning scope on every tile it paints for an audience', async () => {
    const { fillTileMedia } = await importFixture('../apps/photos/media.js');

    const shared = document.createElement('div');
    fillTileMedia(shared, {
      asset_id: 'a1',
      scope_id: 'family',
      thumb_uri: '/centraid/_vault/blobs/abc?variant=thumb',
    });
    expect(shared.dataset.scope).toBe('family');
    // The staged reference the observer will promote sits INSIDE the stamp.
    const image = shared.querySelector('img')!;
    expect(image.dataset.prefetchSrc).toBe('/centraid/_vault/blobs/abc?variant=thumb');
    expect(image.closest('[data-scope]')).toBe(shared);

    // A placeholder tile (no renderable source) is stamped just the same — the
    // branch that paints no <img> must not be the one that forgets.
    const placeholder = document.createElement('div');
    fillTileMedia(placeholder, { asset_id: 'a2', scope_id: 'family', kind: 'audio' });
    expect(placeholder.dataset.scope).toBe('family');

    // A solo mount has no scope to name, and stamping an empty one would make
    // the authorizer address a scope called "" instead of the ambient one.
    const solo = document.createElement('div');
    fillTileMedia(solo, { asset_id: 'a3', thumb_uri: '/centraid/_vault/blobs/def' });
    expect(solo.hasAttribute('data-scope')).toBe(false);
  });

  // Asset ids are per-scope too, so the same id can arrive from two scopes.
  // The once-per-mount guard must not read that as "already painted".
  test('repaints a tile when the same asset id arrives from another scope', async () => {
    const { mountMedia } = await importFixture('../apps/photos/media.js');
    const tile = document.createElement('div');

    mountMedia(tile, { asset_id: 'shared-id', thumb_uri: '/centraid/_vault/blobs/mine' });
    expect(tile.hasAttribute('data-scope')).toBe(false);
    expect(tile.querySelectorAll('img')).toHaveLength(1);

    mountMedia(tile, {
      asset_id: 'shared-id',
      scope_id: 'family',
      thumb_uri: '/centraid/_vault/blobs/theirs',
    });
    expect(tile.dataset.scope).toBe('family');

    // A second call for the SAME scope and id is still the no-op it has to be
    // (React invokes the callback ref on every render).
    const painted = tile.querySelectorAll('img').length;
    mountMedia(tile, {
      asset_id: 'shared-id',
      scope_id: 'family',
      thumb_uri: '/centraid/_vault/blobs/theirs',
    });
    expect(tile.querySelectorAll('img')).toHaveLength(painted);
  });
});
