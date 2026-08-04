import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The inline kit is imported (transitively, via the module under test) FIRST so
// its `./suppress-served-ask` side effect runs before the real kit module. This
// suite exercises the generic blob-image authorizer (issue #505 Phase 4).
import { flushMacrotasks } from "@centraid/test-kit/flush";

import type * as TypeImport_oycips from "../../gateway-client-core.js";
import { installInlineBlobImages } from "./inline-blob-images.js";

// gateway-client-core is the choke point authorizeBlobUrl routes through; stub
// it and hand back a fake blob per request.
const { doFetch, readJson } = vi.hoisted(() => ({
  doFetch: vi.fn<(...args: unknown[]) => Promise<Response>>(),
  readJson: vi.fn<(res: Response, op: string) => Promise<unknown>>(),
}));
vi.mock(import("../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_oycips.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
  })),
  // Explicit `Record<string, string>` return type (matching the real
  // `authHeaders`) so the empty-object branch isn't narrowed to
  // `{ Authorization?: undefined }`, which isn't assignable to it.
  authHeaders: (token?: string): Record<string, string> =>
    token ? { Authorization: `Bearer ${token}` } : {},
  doFetch: (...args: unknown[]) => doFetch(...args),
  readJson: <T>(...args: Parameters<typeof readJson>) =>
    readJson(...args) as Promise<T>,
}));

function blobRes(ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: new Headers(),
    blob: async () => new Blob(["bytes"], { type: "image/jpeg" }),
  } as unknown as Response;
}

let created: string[] = [];
let revoked: string[] = [];
let seq = 0;

describe("inline-blob-images", () => {
  beforeEach(() => {
    created = [];
    revoked = [];
    seq = 0;
    // jsdom implements neither createObjectURL nor revokeObjectURL — supply both.
    (
      URL as unknown as { createObjectURL: (b: Blob) => string }
    ).createObjectURL = () => {
      const url = `blob:mock/${++seq}`;
      created.push(url);
      return url;
    };
    (
      URL as unknown as { revokeObjectURL: (u: string) => void }
    ).revokeObjectURL = (u: string) => {
      revoked.push(u);
    };
    doFetch.mockImplementation(async () => blobRes(true));
  });

  afterEach(() => {
    doFetch.mockReset();
    document.body.innerHTML = "";
  });

  const flush = flushMacrotasks;

  describe(installInlineBlobImages, () => {
    it("swaps an <img> src pointing at /_vault/blobs to an authed object URL", async () => {
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.setAttribute("src", "/centraid/_vault/blobs/abc?variant=thumb");
      root.appendChild(img);
      document.body.appendChild(root);

      const teardown = installInlineBlobImages(root);
      await flush();

      expect(doFetch).toHaveBeenCalledOnce();
      expect(doFetch.mock.calls[0]?.[1]).toBe(
        "/centraid/_vault/blobs/abc?variant=thumb"
      );
      expect(img.getAttribute("src")).toMatch(/^blob:mock\//u);
      teardown();
    });

    it("rewrites data-prefetch-src BEFORE it becomes src (the lazy grid path)", async () => {
      const root = document.createElement("div");
      document.body.appendChild(root);
      const teardown = installInlineBlobImages(root);

      // media-observer stages the blob URL here, ahead of the viewport.
      const img = document.createElement("img");
      img.dataset.prefetchSrc = "/centraid/_vault/blobs/lazy";
      root.appendChild(img);
      await flush();

      const staged = img.dataset.prefetchSrc;
      expect(staged).toMatch(/^blob:mock\//u);
      // When the tile scrolls in, media-observer copies the (now authed) staged URL
      // into src — never an unauthorized /_vault/blobs URL, so no onerror.
      expect(staged?.startsWith("/centraid/_vault/blobs")).toBe(false);
      teardown();
    });

    // #708 (web host). Stamping an origin is not enough: the browser starts
    // loading a relative vault path the moment it lands in `src`, and off the
    // gateway origin that path answers with the SPA's index.html — so the
    // `<img>` fires `error` and photos tore the tile down before this fetch
    // could settle. `data-blob-pending` is the claim that makes the app hold
    // its promotion and defer that error; it MUST be visible from the moment
    // the fetch starts, and gone the moment it settles.
    it("claims an element with data-blob-pending for the life of the fetch", async () => {
      let resolveFetch: (r: Response) => void = () => undefined;
      doFetch.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.dataset.prefetchSrc = "/centraid/_vault/blobs/slow";
      root.appendChild(img);
      document.body.appendChild(root);

      const teardown = installInlineBlobImages(root);
      await flush();
      expect(img.dataset.blobPending).toBe("1");
      // Still the raw path: the app is holding, waiting on exactly this claim.
      expect(img.dataset.prefetchSrc).toBe("/centraid/_vault/blobs/slow");

      resolveFetch(blobRes(true));
      await flush();

      expect(Object.hasOwn(img.dataset, "blobPending")).toBe(false);
      expect(img.dataset.prefetchSrc).toMatch(/^blob:mock\//u);
      teardown();
    });

    // The other settle. With the claim released the deferred `error` has to
    // come back, or a tile the app is holding waits forever and never paints
    // its placeholder.
    it("clears the claim and re-fires error when authorization fails", async () => {
      doFetch.mockImplementation(async () => blobRes(false));
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.setAttribute("src", "/centraid/_vault/blobs/gone");
      root.appendChild(img);
      document.body.appendChild(root);

      const errors: string[] = [];
      img.addEventListener("error", () => {
        errors.push(img.dataset.blobPending ?? "cleared");
      });

      const teardown = installInlineBlobImages(root);
      await flush();

      expect(img.getAttribute("src")).toBe("/centraid/_vault/blobs/gone");
      // Exactly one terminal error, and the claim is already gone when it
      // arrives — otherwise the app would defer it a second time.
      expect(errors).toStrictEqual(["cleared"]);
      teardown();
    });

    // A failure on a sink whose element is no longer pointed at a raw vault
    // path (the staged copy, or an <img> already showing authed bytes) has
    // nothing to report — a spurious `error` there would placeholder a tile
    // that is painting fine.
    it("does not fire error for a failure on a non-src sink", async () => {
      doFetch.mockImplementation(async () => blobRes(false));
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.dataset.prefetchSrc = "/centraid/_vault/blobs/gone";
      root.appendChild(img);
      document.body.appendChild(root);

      const onError = vi.fn<() => void>();
      img.addEventListener("error", onError);

      const teardown = installInlineBlobImages(root);
      await flush();

      expect(onError).not.toHaveBeenCalled();
      expect(Object.hasOwn(img.dataset, "blobPending")).toBe(false);
      teardown();
    });

    it("authorizes a CSS background-image url() (album covers)", async () => {
      const root = document.createElement("div");
      const cover = document.createElement("span");
      cover.style.backgroundImage = "url(/centraid/_vault/blobs/cover1)";
      root.appendChild(cover);
      document.body.appendChild(root);

      const teardown = installInlineBlobImages(root);
      await flush();

      expect(doFetch).toHaveBeenCalledOnce();
      expect(cover.style.backgroundImage).toMatch(/^url\("blob:mock\//u);
      teardown();
    });

    it("leaves non-blob and already-authed refs untouched", async () => {
      const root = document.createElement("div");
      const dataImg = document.createElement("img");
      dataImg.setAttribute("src", "data:image/png;base64,AAAA");
      const blobImg = document.createElement("img");
      blobImg.setAttribute("src", "blob:mock/existing");
      root.append(dataImg, blobImg);
      document.body.appendChild(root);

      const teardown = installInlineBlobImages(root);
      await flush();

      expect(doFetch).not.toHaveBeenCalled();
      expect(dataImg.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      teardown();
    });

    it("revokes every object URL it created on teardown (no leak)", async () => {
      const root = document.createElement("div");
      const a = document.createElement("img");
      a.setAttribute("src", "/centraid/_vault/blobs/a");
      const b = document.createElement("img");
      b.setAttribute("src", "/centraid/_vault/blobs/b");
      root.append(a, b);
      document.body.appendChild(root);

      const teardown = installInlineBlobImages(root);
      await flush();
      expect(created).toHaveLength(2);
      expect(revoked).toHaveLength(0);

      teardown();
      expect(revoked.sort()).toStrictEqual([...created].sort());
    });

    // The blank-photo-grid bug (a re-render of the app re-ran the mount
    // callback; its teardown revoked every live object URL and the re-install
    // skipped the already-swapped tiles, so they stayed pointed at revoked URLs
    // and the browser answered ERR_FILE_NOT_FOUND).
    it("re-authorizes an <img> left holding a revoked blob: src", async () => {
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.setAttribute("src", "/centraid/_vault/blobs/abc");
      root.appendChild(img);
      document.body.appendChild(root);

      const first = installInlineBlobImages(root);
      await flush();
      const swapped = img.getAttribute("src");
      expect(swapped).toMatch(/^blob:mock\//u);

      // A genuine unmount/remount: teardown revokes, so the mounted <img> is now
      // holding a dead URL with no /_vault/blobs reference left anywhere on it.
      first();
      expect(revoked).toStrictEqual([swapped]);

      const second = installInlineBlobImages(root);
      await flush();

      expect(doFetch).toHaveBeenCalledTimes(2);
      expect(doFetch.mock.calls[1]?.[1]).toBe("/centraid/_vault/blobs/abc");
      const reauthorized = img.getAttribute("src");
      expect(reauthorized).toMatch(/^blob:mock\//u);
      expect(reauthorized).not.toBe(swapped); // a LIVE url, not the revoked one
      second();
    });

    it("re-authorizes a lazy tile whose authed src came from data-prefetch-src", async () => {
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.dataset.prefetchSrc = "/centraid/_vault/blobs/lazy";
      root.appendChild(img);
      document.body.appendChild(root);

      const first = installInlineBlobImages(root);
      await flush();
      // media-observer copies the staged (authed) URL into src when the tile
      // scrolls in — src NEVER held a /_vault/blobs value on this path.
      const staged = img.dataset.prefetchSrc!;
      img.setAttribute("src", staged);
      await flush();
      first();

      const second = installInlineBlobImages(root);
      await flush();

      // One refetch, not two: the vestigial staged copy rides the src recovery.
      expect(doFetch).toHaveBeenCalledTimes(2);
      expect(doFetch.mock.calls[1]?.[1]).toBe("/centraid/_vault/blobs/lazy");
      expect(img.getAttribute("src")).toMatch(/^blob:mock\//u);
      expect(img.getAttribute("src")).not.toBe(staged);
      second();
    });

    it("re-authorizes a background-image cover holding a revoked blob: url", async () => {
      const root = document.createElement("div");
      const cover = document.createElement("span");
      cover.style.backgroundImage = "url(/centraid/_vault/blobs/cover1)";
      root.appendChild(cover);
      document.body.appendChild(root);

      const first = installInlineBlobImages(root);
      await flush();
      const swapped = cover.style.backgroundImage;
      first();

      const second = installInlineBlobImages(root);
      await flush();

      expect(doFetch).toHaveBeenCalledTimes(2);
      expect(doFetch.mock.calls[1]?.[1]).toBe("/centraid/_vault/blobs/cover1");
      expect(cover.style.backgroundImage).toMatch(/^url\("blob:mock\//u);
      expect(cover.style.backgroundImage).not.toBe(swapped);
      second();
    });

    it("stops authorizing after teardown and revokes a late-arriving object URL", async () => {
      let resolveFetch: (r: Response) => void = () => undefined;
      doFetch.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );
      const root = document.createElement("div");
      const img = document.createElement("img");
      img.setAttribute("src", "/centraid/_vault/blobs/slow");
      root.appendChild(img);
      document.body.appendChild(root);

      const teardown = installInlineBlobImages(root);
      await flush();
      teardown(); // tears down while the authorize fetch is still in flight

      resolveFetch(blobRes(true));
      await flush();

      // The late object URL is created then immediately revoked; src is never set.
      expect(img.getAttribute("src")).toBe("/centraid/_vault/blobs/slow");
      expect(revoked).toStrictEqual(created);
    });
  });
});
