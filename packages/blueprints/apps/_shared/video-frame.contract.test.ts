// @vitest-environment jsdom
// Laws for the one canonical browser video poster/thumb pipeline (#656 Layer
// 1B — the module had no test file). This is the only hardware-decoded capture
// path either shell has, so the laws are about RESOURCE DISCIPLINE as much as
// output: a capture never throws at its caller (a thumbnail is best-effort),
// the object URL is always revoked, and the element is always torn down —
// otherwise a photo import leaks one decoded video per file.

import { afterEach, describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import {
  captureVideoFrames,
  VIDEO_CAPTURE_TIMEOUT_MS,
  VIDEO_POSTER_EDGE,
  VIDEO_THUMB_EDGE,
} from "./video-frame.js";

/** A decoder stand-in: jsdom ships no media pipeline, so the element is the seam. */
class FakeVideo extends EventTarget {
  videoWidth = 1920;
  videoHeight = 1080;
  duration = 10;
  readyState = 0;
  muted = false;
  playsInline = false;
  preload = "";
  paused = true;
  loads = 0;
  removedAttributes: string[] = [];
  /** Events this fake refuses to fire, so a test can stall one stage. */
  silent = new Set<string>();
  #currentTime = 0;

  #src = "";

  get src(): string {
    return this.#src;
  }

  set src(value: string) {
    this.#src = value;
  }

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
  }

  load(): void {
    this.loads += 1;
  }

  pause(): void {
    this.paused = true;
  }

  removeAttribute(name: string): void {
    this.removedAttributes.push(name);
  }

  /**
   * A real decoder fires whenever it is ready, which may be before or after the
   * pipeline subscribes. Firing ON subscribe models the "already ready" case
   * deterministically without racing the code under test; `silent` models a
   * stage that never becomes ready.
   */
  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean
  ): void {
    super.addEventListener(type, listener, options);
    if (this.silent.has(type)) return;
    queueMicrotask(() => this.dispatchEvent(new Event(type)));
  }
}

interface FakeCanvas {
  width: number;
  height: number;
  quality: number | undefined;
  /** `null` reproduces a browser that refuses a 2d context (blocked canvas). */
  context: { drawImage: () => void } | null;
  getContext: () => { drawImage: () => void } | null;
  toBlob: (
    callback: (blob: Blob | null) => void,
    type: string,
    quality: number
  ) => void;
}

/** A factory, not a class: the repo caps one class per file and FakeVideo owns it. */
function fakeCanvas(): FakeCanvas {
  const canvas: FakeCanvas = {
    width: 0,
    height: 0,
    quality: undefined,
    context: { drawImage: () => undefined },
    getContext: () => canvas.context,
    toBlob: (callback, type, quality) => {
      canvas.quality = quality;
      callback(new Blob([`${type}:${canvas.width}x${canvas.height}`]));
    },
  };
  return canvas;
}

const realCreateElement = document.createElement.bind(document);
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
const revoked: string[] = [];
let video = new FakeVideo();
let canvases: FakeCanvas[] = [];

function installFakeMedia(): void {
  video = new FakeVideo();
  canvases = [];
  revoked.length = 0;
  URL.createObjectURL = () => "blob:centraid/video";
  URL.revokeObjectURL = (url: string) => revoked.push(url) && undefined;
  document.createElement = ((tag: string) => {
    if (tag === "video") return video as unknown as HTMLVideoElement;
    if (tag === "canvas") {
      const canvas = fakeCanvas();
      canvases.push(canvas);
      return canvas as unknown as HTMLCanvasElement;
    }
    return realCreateElement(tag);
  }) as typeof document.createElement;
}

describe("video frame capture seam", () => {
  afterEach(() => {
    document.createElement = realCreateElement;
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  });

  it("law: a capture yields a poster and a thumb at their declared edges", async () => {
    installFakeMedia();

    const frames = await captureVideoFrames(new Blob(["mp4"]));

    expect(frames).toMatchObject({ width: 1920, height: 1080, duration: 10 });
    expect(canvases.map((canvas) => canvas.width)).toStrictEqual([
      Math.round(1920 * Math.min(1, VIDEO_POSTER_EDGE / 1920)),
      Math.round(1920 * Math.min(1, VIDEO_THUMB_EDGE / 1920)),
    ]);
  });

  it("law: a bounded video is sampled at its midpoint, never at frame zero", async () => {
    installFakeMedia();

    await captureVideoFrames(new Blob(["mp4"]));

    expect(video.currentTime).toBe(1);
  });

  it("law: a zero-length video captures its first frame without seeking", async () => {
    installFakeMedia();
    video.duration = 0;
    video.readyState = 0;

    const frames = await captureVideoFrames(new Blob(["mp4"]));

    expect(video.currentTime).toBe(0);
    expect(frames?.duration).toBe(0);
  });

  it("law: an already-decoded first frame skips the extra wait", async () => {
    installFakeMedia();
    video.duration = 0;
    video.readyState = 4;
    video.silent.add("loadeddata");

    await expect(captureVideoFrames(new Blob(["mp4"]))).resolves.toMatchObject({
      width: 1920,
    });
  });

  it("law: an unmeasurable duration reports null rather than a fabricated number", async () => {
    installFakeMedia();
    video.duration = Number.NaN;

    const frames = await captureVideoFrames(new Blob(["mp4"]));

    expect(frames?.duration).toBeNull();
  });

  it("law: a video with no dimensions yields nothing at all", async () => {
    installFakeMedia();
    video.videoWidth = 0;

    await expect(captureVideoFrames(new Blob(["mp4"]))).resolves.toBeNull();
  });

  it("law: a refused 2d context degrades to null frames, not to a failure", async () => {
    installFakeMedia();
    const original = document.createElement;
    document.createElement = ((tag: string) => {
      const element = original.call(document, tag) as unknown;
      if (tag === "canvas") (element as FakeCanvas).context = null;
      return element;
    }) as typeof document.createElement;

    await expect(captureVideoFrames(new Blob(["mp4"]))).resolves.toMatchObject({
      poster: null,
      thumb: null,
    });
  });

  it("law: a decode error is null, never a thrown capture", async () => {
    installFakeMedia();
    video.silent.add("loadedmetadata");

    await expect(captureVideoFrames(new Blob(["mp4"]))).resolves.toBeNull();
  });

  it("law: a decoder that never answers gives up on the declared budget", async () => {
    installFakeMedia();
    const clock = useFakeClock(0);
    for (const event of ["loadedmetadata", "loadeddata", "seeked", "error"])
      video.silent.add(event);

    const pending = captureVideoFrames(new Blob(["mp4"]));
    await clock.advance(VIDEO_CAPTURE_TIMEOUT_MS);

    await expect(pending).resolves.toBeNull();
  });

  it("law: the object URL and the element are torn down on every path", async () => {
    installFakeMedia();
    video.videoWidth = 0;

    await captureVideoFrames(new Blob(["mp4"]));

    expect(revoked).toStrictEqual(["blob:centraid/video"]);
    expect(video.paused).toBe(true);
    expect(video.removedAttributes).toStrictEqual(["src"]);
  });

  it("law: a host with no object-URL support declines instead of half-capturing", async () => {
    installFakeMedia();
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;

    await expect(captureVideoFrames(new Blob(["mp4"]))).resolves.toBeNull();
  });
});
