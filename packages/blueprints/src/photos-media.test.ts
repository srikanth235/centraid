// @vitest-environment jsdom
// oxlint-disable-next-line typescript-eslint/ban-ts-comment -- browser-DOM fixture is intentionally checked by jsdom, while the blueprint TS config excludes DOM globals (#406)
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// oxlint-disable-next-line vitest/prefer-import-in-mock -- the typed `import()` form pulls `apps/` into this program's `rootDir: ./src` and fails typecheck (TS6059); apps are typechecked by tsconfig.apps.json.
vi.mock("../apps/photos/format.js", () => ({
  isVideoAsset: (asset: Record<string, unknown>) =>
    asset.kind === "video" ||
    String(asset.media_type ?? "").startsWith("video/"),
  isAudioAsset: (asset: Record<string, unknown>) =>
    asset.kind === "audio" ||
    String(asset.media_type ?? "").startsWith("audio/"),
}));

const importFixture = (relativePath: string) => import(relativePath);

interface FakeObserver {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit;
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
}

const observers: FakeObserver[] = [];
const mutationCallbacks: MutationCallback[] = [];
let mutationCallback: MutationCallback | undefined;

/** Fires every live MutationObserver, as a real attribute change would. */
function flushMutations(): void {
  for (const fire of mutationCallbacks.slice())
    fire([], {} as MutationObserver);
}

describe("Photos next-screen media loading", () => {
  beforeEach(() => {
    vi.resetModules();
    observers.length = 0;
    mutationCallbacks.length = 0;
    mutationCallback = undefined;
    document.body.innerHTML = "";
    vi.stubGlobal(
      "IntersectionObserver",
      FakeIntersectionObserver as unknown as typeof IntersectionObserver
    );
    vi.stubGlobal(
      "MutationObserver",
      FakeMutationObserver as unknown as typeof MutationObserver
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  class FakeIntersectionObserver {
    readonly observe = vi.fn<IntersectionObserver["observe"]>();
    readonly unobserve = vi.fn<IntersectionObserver["unobserve"]>();

    constructor(
      readonly callback: IntersectionObserverCallback,
      readonly options: IntersectionObserverInit
    ) {
      observers.push(this);
    }
  }

  function FakeMutationObserver(callback: MutationCallback) {
    mutationCallback = callback;
    mutationCallbacks.push(callback);
    vi.spyOn(this, "observe").mockReturnValue(undefined);
    vi.spyOn(this, "disconnect").mockReturnValue(undefined);
  }
  FakeMutationObserver.prototype.observe = () => undefined;
  FakeMutationObserver.prototype.disconnect = () => undefined;

  test("roots the one-screen lookahead in the overflowing photo pane", async () => {
    const { observeNextScreen } = await importFixture(
      "../apps/photos/media-observer.js"
    );
    const scrollPane = document.createElement("div");
    scrollPane.style.overflowY = "auto";
    const tile = document.createElement("div");
    const image = document.createElement("img");
    tile.append(image);
    scrollPane.append(tile);
    document.body.append(scrollPane);

    observeNextScreen(image, "/centraid/_vault/blobs/photo?variant=thumb");

    expect(observers).toHaveLength(1);
    expect(observers[0]?.options).toMatchObject({
      root: scrollPane,
      rootMargin: "100% 0px",
    });
    expect(observers[0]?.observe).toHaveBeenCalledWith(image);
    expect(image.getAttribute("src")).toBeNull();

    observers[0]?.callback(
      [{ isIntersecting: true, target: image } as IntersectionObserverEntry],
      observers[0] as unknown as IntersectionObserver
    );
    expect(image.getAttribute("src")).toBe(
      "/centraid/_vault/blobs/photo?variant=thumb"
    );
    expect(observers[0]?.unobserve).toHaveBeenCalledWith(image);
  });

  // A relative `/centraid/_vault/blobs/…` path is the gateway only on the served
  // path; in the shell it resolves to the SPA's index.html. The staged value must
  // never reach `src` while the authorizer claims that reference (#708).
  test("holds the staged promotion while the shell authorizes a vault path", async () => {
    const { observeNextScreen } = await importFixture(
      "../apps/photos/media-observer.js"
    );
    const image = document.createElement("img");
    document.body.append(image);

    observeNextScreen(image, "/centraid/_vault/blobs/photo?variant=thumb");
    image.dataset.blobPending = "1";

    observers[0]?.callback(
      [{ isIntersecting: true, target: image } as IntersectionObserverEntry],
      observers[0] as unknown as IntersectionObserver
    );

    expect(image.getAttribute("src")).toBeNull();
    expect(image.dataset.prefetchSrc).toBe(
      "/centraid/_vault/blobs/photo?variant=thumb"
    );

    image.dataset.prefetchSrc = "blob:mock/1";
    delete image.dataset.blobPending;
    flushMutations();

    expect(image.getAttribute("src")).toBe("blob:mock/1");
    expect(Object.hasOwn(image.dataset, "prefetchSrc")).toBe(false);
  });

  test("resumes a held promotion when authorization gives up", async () => {
    const { observeNextScreen } = await importFixture(
      "../apps/photos/media-observer.js"
    );
    const image = document.createElement("img");
    document.body.append(image);

    observeNextScreen(image, "/centraid/_vault/blobs/photo");
    image.dataset.blobPending = "1";
    observers[0]?.callback(
      [{ isIntersecting: true, target: image } as IntersectionObserverEntry],
      observers[0] as unknown as IntersectionObserver
    );
    expect(image.getAttribute("src")).toBeNull();

    delete image.dataset.blobPending;
    flushMutations();

    expect(image.getAttribute("src")).toBe("/centraid/_vault/blobs/photo");
  });

  test("promotes a vault path immediately when no authorizer claimed it", async () => {
    const { observeNextScreen } = await importFixture(
      "../apps/photos/media-observer.js"
    );
    const image = document.createElement("img");
    document.body.append(image);

    observeNextScreen(image, "/centraid/_vault/blobs/photo?variant=thumb");
    observers[0]?.callback(
      [{ isIntersecting: true, target: image } as IntersectionObserverEntry],
      observers[0] as unknown as IntersectionObserver
    );

    expect(image.getAttribute("src")).toBe(
      "/centraid/_vault/blobs/photo?variant=thumb"
    );
    expect(observers[0]?.unobserve).toHaveBeenCalledWith(image);
  });

  // saveData / no IntersectionObserver puts the raw path straight into `src`, so
  // it can fail before the authorizer settles. That error is the un-authorized
  // load, not the asset — tearing the tile down there empties the grid.
  test("does not placeholder a tile whose error arrives mid-authorization", async () => {
    const { fillTileMedia } = await importFixture("../apps/photos/media.js");

    const tile = document.createElement("div");
    fillTileMedia(tile, {
      asset_id: "a1",
      kind: "photo",
      content_uri: "/centraid/_vault/blobs/abc",
      thumb_uri: null,
    });
    const image = tile.querySelector("img")!;
    image.src = image.dataset.prefetchSrc ?? "";
    image.dataset.blobPending = "1";

    image.dispatchEvent(new Event("error"));
    expect(tile.querySelector("img")).toBe(image);
    expect(tile.classList.contains("is-placeholder")).toBe(false);
    expect(Object.hasOwn(image.dataset, "originalFallback")).toBe(false);

    delete image.dataset.blobPending;
    image.setAttribute("src", "blob:mock/1");
    expect(tile.classList.contains("is-placeholder")).toBe(false);
  });

  test("placeholders the tile once authorization has given up", async () => {
    const { fillTileMedia } = await importFixture("../apps/photos/media.js");

    const tile = document.createElement("div");
    fillTileMedia(tile, {
      asset_id: "a1",
      kind: "photo",
      content_uri: "/centraid/_vault/blobs/abc",
      thumb_uri: null,
    });
    const image = tile.querySelector("img")!;
    image.src = image.dataset.prefetchSrc ?? "";
    image.dataset.blobPending = "1";
    image.dispatchEvent(new Event("error"));
    expect(tile.classList.contains("is-placeholder")).toBe(false);

    delete image.dataset.blobPending;
    image.dispatchEvent(new Event("error")); // the authorizer's re-fire
    image.dispatchEvent(new Event("error")); // the retried original fails too
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.classList.contains("is-placeholder")).toBe(true);
  });

  test("keeps observers scoped per scroll container and releases detached tiles", async () => {
    const { observeNextScreen } = await importFixture(
      "../apps/photos/media-observer.js"
    );
    const roots = [
      document.createElement("div"),
      document.createElement("div"),
    ];
    const tiles = roots.map((root) => {
      root.style.overflowY = "auto";
      const tile = document.createElement("div");
      const image = document.createElement("img");
      tile.append(image);
      root.append(tile);
      document.body.append(root);
      observeNextScreen(image, "data:image/png;base64,AA==");
      return { tile, image };
    });

    expect(observers).toHaveLength(2);
    expect(observers[0]?.options.root).toBe(roots[0]);
    expect(observers[1]?.options.root).toBe(roots[1]);

    tiles[0]?.tile.remove();
    mutationCallback?.(
      [{ removedNodes: [tiles[0]?.tile] } as unknown as MutationRecord],
      {} as MutationObserver
    );
    expect(observers[1]?.unobserve).not.toHaveBeenCalled();
    expect(observers[0]?.unobserve).toHaveBeenCalledWith(tiles[0]?.image);
  });

  test("uses posters for video grids and never pulls a media original", async () => {
    const { gridSrc } = await importFixture("../apps/photos/media.js");

    expect(
      gridSrc({
        kind: "video",
        content_uri: "/centraid/_vault/blobs/original-video",
        poster_uri: "/centraid/_vault/blobs/poster",
      })
    ).toBe("/centraid/_vault/blobs/poster");
    expect(
      gridSrc({
        kind: "video",
        content_uri: "/centraid/_vault/blobs/original-video",
        poster_uri: null,
      })
    ).toBeNull();
    expect(
      gridSrc({
        kind: "audio",
        content_uri: "/centraid/_vault/blobs/original-audio",
      })
    ).toBeNull();
  });

  test("paints the original when a photo has no thumb derivative yet", async () => {
    const { gridSrc } = await importFixture("../apps/photos/media.js");

    // `thumb_uri` lands only once the preview backstop writes the derivative
    // row, so every photo sits here after import; null builds no `<img>` at all.
    expect(
      gridSrc({
        content_uri: "/centraid/_vault/blobs/original-photo",
        kind: "photo",
        thumb_uri: null,
      })
    ).toBe("/centraid/_vault/blobs/original-photo");
  });

  test("still refuses a thumb-less original that lives off this device", async () => {
    const { gridSrc } = await importFixture("../apps/photos/media.js");

    expect(
      gridSrc({
        content_uri: "https://example.test/original.jpg",
        kind: "photo",
        thumb_uri: null,
      })
    ).toBeNull();
  });

  test("renders duration and media-specific lightweight placeholders", async () => {
    const { durationLabel, fillTileMedia } = await importFixture(
      "../apps/photos/media.js"
    );
    expect(durationLabel(65)).toBe("1:05");
    expect(durationLabel(3_661)).toBe("1:01:01");
    expect(durationLabel(-1)).toBeNull();

    const video = document.createElement("div");
    fillTileMedia(video, { kind: "video", poster_uri: null, duration_s: 65 });
    expect(video.classList.contains("is-placeholder")).toBe(true);
    expect(video.querySelector(".ph-tile-video-badge")).not.toBeNull();
    expect(video.querySelector(".ph-tile-duration")?.textContent).toBe("1:05");

    const audio = document.createElement("div");
    fillTileMedia(audio, { kind: "audio", duration_s: 3_661 });
    expect(audio.querySelector(".ph-tile-audio-badge")).not.toBeNull();
    expect(audio.querySelector(".ph-tile-duration")?.textContent).toBe(
      "1:01:01"
    );
  });

  // A "0:00" chip on a still reads as a video that will not play (#708).
  test("never stamps a duration on a still photo", async () => {
    const { durationLabel, fillTileMedia } = await importFixture(
      "../apps/photos/media.js"
    );
    expect(durationLabel(0)).toBeNull();

    const still = document.createElement("div");
    fillTileMedia(still, {
      asset_id: "s1",
      kind: "photo",
      duration_s: 0,
      thumb_uri: "/centraid/_vault/blobs/still?variant=thumb",
    });
    expect(still.querySelector(".ph-tile-duration")).toBeNull();

    const oddStill = document.createElement("div");
    fillTileMedia(oddStill, {
      asset_id: "s2",
      kind: "photo",
      duration_s: 12,
      thumb_uri: "/centraid/_vault/blobs/odd?variant=thumb",
    });
    expect(oddStill.querySelector(".ph-tile-duration")).toBeNull();
  });

  // A missing derivative and a `blob:` URL revoked mid-decode both surface as one
  // `error`; the tile retries the original once before giving up (#708).
  test("retries the original once before falling back to a placeholder", async () => {
    const { fillTileMedia } = await importFixture("../apps/photos/media.js");

    const tile = document.createElement("div");
    fillTileMedia(tile, {
      asset_id: "a1",
      kind: "photo",
      content_uri: "/centraid/_vault/blobs/abc",
      thumb_uri: "/centraid/_vault/blobs/abc?variant=thumb",
      width: 4_000,
      height: 3_000,
    });
    const image = tile.querySelector("img")!;
    image.src = image.dataset.prefetchSrc ?? "";

    image.dispatchEvent(new Event("error"));
    expect(image.parentElement).toBe(tile);
    expect(image.getAttribute("src")).toBe("/centraid/_vault/blobs/abc");
    expect(tile.classList.contains("is-placeholder")).toBe(false);

    image.dispatchEvent(new Event("error"));
    expect(tile.querySelector("img")).toBeNull();
    expect(tile.classList.contains("is-placeholder")).toBe(true);
  });

  // The authorizer resolves a blob reference in the scope named by the element's
  // nearest `data-scope`. Content ids collide across scopes by design, so an
  // unstamped audience tile renders a different photo, not a 404 — the stamp must
  // land before the media element exists so it covers `data-prefetch-src` (#599).
  test("stamps the owning scope on every tile it paints for an audience", async () => {
    const { fillTileMedia } = await importFixture("../apps/photos/media.js");

    const shared = document.createElement("div");
    fillTileMedia(shared, {
      asset_id: "a1",
      scope_id: "family",
      thumb_uri: "/centraid/_vault/blobs/abc?variant=thumb",
    });
    expect(shared.dataset.scope).toBe("family");
    const image = shared.querySelector("img")!;
    expect(image.dataset.prefetchSrc).toBe(
      "/centraid/_vault/blobs/abc?variant=thumb"
    );
    expect(image.closest("[data-scope]")).toBe(shared);

    const placeholder = document.createElement("div");
    fillTileMedia(placeholder, {
      asset_id: "a2",
      scope_id: "family",
      kind: "audio",
    });
    expect(placeholder.dataset.scope).toBe("family");

    // An empty stamp would address a scope called "" instead of the ambient one.
    const solo = document.createElement("div");
    fillTileMedia(solo, {
      asset_id: "a3",
      thumb_uri: "/centraid/_vault/blobs/def",
    });
    expect(Object.hasOwn(solo.dataset, "scope")).toBe(false);
  });

  // Asset ids are per-scope: the once-per-mount guard must not read the same id
  // from another scope as "already painted".
  test("repaints a tile when the same asset id arrives from another scope", async () => {
    const { mountMedia } = await importFixture("../apps/photos/media.js");
    const tile = document.createElement("div");

    mountMedia(tile, {
      asset_id: "shared-id",
      thumb_uri: "/centraid/_vault/blobs/mine",
    });
    expect(Object.hasOwn(tile.dataset, "scope")).toBe(false);
    expect(tile.querySelectorAll("img")).toHaveLength(1);

    mountMedia(tile, {
      asset_id: "shared-id",
      scope_id: "family",
      thumb_uri: "/centraid/_vault/blobs/theirs",
    });
    expect(tile.dataset.scope).toBe("family");

    const painted = tile.querySelectorAll("img").length;
    mountMedia(tile, {
      asset_id: "shared-id",
      scope_id: "family",
      thumb_uri: "/centraid/_vault/blobs/theirs",
    });
    expect(tile.querySelectorAll("img")).toHaveLength(painted);
  });
});
