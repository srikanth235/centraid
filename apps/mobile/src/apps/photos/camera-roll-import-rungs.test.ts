// THE PHONE'S DISPLAY RUNGS ON THE IMPORT PATH (#1011).
//
// The gateway's preview codec is sharp, and the pinned
// `@img/sharp-libvips-darwin-arm64` ships libheif WITHOUT an HEVC decoder, so
// the HEIC an iPhone actually writes declines there and earns the durable
// `preview-codec@1` "unsupported" stamp — after which every recognition recipe
// skips it. iOS decodes it natively, so the Import path renders the ladder's
// rungs on device and contributes them through the variant door.
//
// What this file pins is the REQUEST SEQUENCE and the rung shapes, against the
// real HEVC-coded fixture the gateway's own preview tests decline
// (`packages/server/src/preview/fixtures/hevc-photo.heic`). The native imaging
// stack is stubbed — a unit test decodes no HEIC — but every wire fact the
// gateway checks (order, sha, variant, media type, edge) is real.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type * as TypeImport_manip from "expo-image-manipulator";
import type * as TypeImport_videoThumbs from "expo-video-thumbnails";
import type * as TypeImport_jpeg from "jpeg-js";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { BLOB_MEDIUM_EDGE, BLOB_TINY_EDGE } from "@centraid/core/blob";

import type * as TypeImport_deviceMedia from "./device-media";

const HEIC_BYTES = new Uint8Array(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../../packages/server/src/preview/fixtures/hevc-photo.heic",
        import.meta.url
      )
    )
  )
);

const HEIC_SHA = createHash("sha256").update(HEIC_BYTES).digest("hex");

/** The durable derivatives directory always exists in the fake. A plain
 *  constructor function rather than a second class: this file already spends
 *  its one-class budget on `FakeFile`. */
function FakeDirectory(this: {
  uri: string;
  exists: boolean;
  create: () => void;
}): void {
  this.uri = "file:///documents/centraid-upload-derivatives";
  this.exists = true;
  this.create = (): void => {
    /* nothing to make */
  };
}

/** A tiny in-memory file system: enough for rung generation and contribution. */
const files = new Map<string, Uint8Array>();

class FakeFile {
  readonly uri: string;

  constructor(base: string | { uri: string }, name?: string) {
    const root = typeof base === "string" ? base : base.uri;
    this.uri = name === undefined ? root : `${root}/${name}`;
  }

  get name(): string {
    return this.uri.split("/").at(-1) ?? this.uri;
  }

  get exists(): boolean {
    return files.has(this.uri);
  }

  bytes(): Promise<Uint8Array> {
    const found = files.get(this.uri);
    if (!found) throw new Error(`no such file ${this.uri}`);
    return Promise.resolve(found);
  }

  copySync(destination: FakeFile): void {
    files.set(destination.uri, files.get(this.uri) ?? new Uint8Array());
  }

  delete(): void {
    files.delete(this.uri);
  }
}

vi.mock(import("expo-file-system"), () => ({
  File: FakeFile as unknown as (typeof import("expo-file-system"))["File"],
  Directory:
    FakeDirectory as unknown as (typeof import("expo-file-system"))["Directory"],
  Paths: {
    document: { uri: "file:///documents" },
  } as unknown as (typeof import("expo-file-system"))["Paths"],
}));

/** The mocked original's true shape — the portrait an iPhone writes. Every
 *  rendered rung's size is derived from it, so the decode below reports the
 *  REAL pixels a rung has rather than a convenient fiction. */
const SOURCE = { width: 3_024, height: 4_032 };

/** Records every render so the test can assert the ladder's edges. */
const renders: {
  uri: string;
  actions: unknown[];
  shape: { width: number; height: number };
}[] = [];

/** What ImageManipulator would produce for one recorded resize. */
function renderedShape(actions: unknown[]): { width: number; height: number } {
  const resize = (
    actions[0] as { resize?: { width?: number; height?: number } }
  )?.resize;
  if (!resize) return SOURCE;
  if (resize.height !== undefined) {
    return {
      width: Math.round((SOURCE.width * resize.height) / SOURCE.height),
      height: resize.height,
    };
  }
  const width = resize.width ?? SOURCE.width;
  return {
    width,
    height: Math.round((SOURCE.height * width) / SOURCE.width),
  };
}

/** Rendering failures are injectable: a device whose codec declines. */
let renderFailure: string | undefined;

vi.mock(import("expo-image-manipulator"), () => ({
  manipulateAsync: ((uri: string, actions: unknown[]) => {
    if (renderFailure !== undefined)
      return Promise.reject(new Error(renderFailure));
    renders.push({ uri, actions, shape: renderedShape(actions) });
    const out = `file:///cache/rung-${renders.length}.jpg`;
    // The trailing byte indexes the render, so the JPEG decode below can hand
    // back that rung's own dimensions.
    files.set(out, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, renders.length]));
    return Promise.resolve({ uri: out, width: 1, height: 1 });
  }) as unknown as typeof TypeImport_manip.manipulateAsync,
  SaveFormat: {
    JPEG: "jpeg",
  } as unknown as typeof TypeImport_manip.SaveFormat,
}));

vi.mock(import("expo-video-thumbnails"), () => ({
  getThumbnailAsync: vi.fn<typeof TypeImport_videoThumbs.getThumbnailAsync>(),
}));

/**
 * THE DECODE REPORTS THE RUNG'S REAL SIZE (#1011). A stub that always answered
 * 9×8 hid the live bug: the inline rungs were hashed from the decoded `thumb`,
 * whose long edge is 256, and the REAL `rgbaToThumbHash` below throws above
 * 100×100 — taking the whole derivative set, and the phone's only HEIC display
 * rungs, down with it, silently.
 */
const jpegStub = {
  decode: (bytes: Uint8Array) => {
    const shape = renders[(bytes[4] ?? 1) - 1]?.shape ?? SOURCE;
    return {
      ...shape,
      data: new Uint8Array(shape.width * shape.height * 4).fill(120),
    };
  },
} as unknown as typeof TypeImport_jpeg;

vi.mock(import("jpeg-js"), () => ({ default: jpegStub, ...jpegStub }));

vi.mock(import("../../lib/gateway"), () => ({ authHeader: () => ({}) }));

vi.mock(import("../../lib/upload/native-digest"), () => ({
  createNativeDigest: () => {
    const hash = createHash("sha256");
    return {
      update(bytes: Uint8Array) {
        hash.update(bytes);
      },
      digestHex() {
        return hash.digest("hex");
      },
    };
  },
}));

const asset = {
  getShape: () => Promise.resolve(SOURCE),
};

vi.mock(import("./device-media"), () => ({
  openDeviceOriginal: (() =>
    Promise.resolve({
      asset,
      uri: "file:///dcim/IMG_0001.HEIC",
    })) as unknown as typeof TypeImport_deviceMedia.openDeviceOriginal,
  liveVideoUri: () => Promise.resolve(null),
}));

const { attemptImportCandidate } = await import("./camera-roll-import-run");
const { gatewayCanDecode, longEdgeResize } =
  await import("../../lib/upload/derivatives-native");

interface Call {
  url: string;
  body: unknown;
}

let calls: Call[];

function installFetch(): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    (url: string, init: { body?: unknown }): Promise<Response> => {
      calls.push({ url, body: init.body });
      const json = url.endsWith("/publish")
        ? { batchId: "b1", created: 1, updated: 0, skipped: 0, failed: 0 }
        : url.includes("/blobs")
          ? { sha256: "x" }
          : {
              batchId: "b1",
              staged: { create: 1, update: 0, skip: 0 },
              unrouted: [],
            };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(json),
      } as Response);
    }
  );
}

let warned: string[];
let logged: string[];

describe("the camera-roll import's device rungs", () => {
  beforeEach(() => {
    files.clear();
    files.set("file:///dcim/IMG_0001.HEIC", HEIC_BYTES);
    renders.length = 0;
    renderFailure = undefined;
    warned = [];
    logged = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      warned.push(String(line));
    });
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    installFetch();
  });

  describe("which originals the phone renders rungs for", () => {
    test("HEIC/HEIF are the formats the gateway cannot decode", () => {
      expect(gatewayCanDecode("IMG_0001.HEIC")).toBe(false);
      expect(gatewayCanDecode("IMG_0001.heic")).toBe(false);
      expect(gatewayCanDecode("IMG_0001.heif")).toBe(false);
      expect(gatewayCanDecode("IMG_0001.hif")).toBe(false);
      expect(gatewayCanDecode("IMG_0001.jpg")).toBe(true);
      expect(gatewayCanDecode("IMG_0001.png")).toBe(true);
      expect(gatewayCanDecode("no-extension")).toBe(true);
    });
  });

  describe("the ladder's edges", () => {
    test("the long edge is fitted, and a small original is never upscaled", () => {
      expect(
        longEdgeResize({ width: 4_032, height: 3_024 }, 256)
      ).toStrictEqual({
        width: 256,
      });
      expect(
        longEdgeResize({ width: 3_024, height: 4_032 }, 256)
      ).toStrictEqual({
        height: 256,
      });
      expect(longEdgeResize({ width: 120, height: 90 }, 256)).toBeNull();
      expect(longEdgeResize(undefined, 256)).toStrictEqual({ width: 256 });
    });

    test("the edges are the vault's own PREVIEW_LADDER constants", () => {
      // The mobile app imports them; this asserts the pair the ladder publishes
      // has not drifted from what the gateway's `TINY_EDGE`/`MEDIUM_EDGE` alias.
      expect(BLOB_TINY_EDGE).toBe(256);
      expect(BLOB_MEDIUM_EDGE).toBe(2_048);
    });
  });

  describe("importing an HEIC original", () => {
    test("stages the original, contributes the rungs, then publishes", async () => {
      await expect(
        attemptImportCandidate("http://gw", {
          filename: "IMG_0001.HEIC",
          id: "a",
          kind: "photo",
          localId: "local-a",
        })
      ).resolves.toBe("imported");

      const urls = calls.map((call) => call.url);
      // ORDER IS THE CONTRACT: `variant_of` needs staged-or-claimed content, and
      // the rungs must be on the row before the publish makes it recognisable.
      expect(urls[0]).toBe("http://gw/centraid/_vault/imports");
      expect(urls.at(-1)).toBe("http://gw/centraid/_vault/imports/b1/publish");

      const rungs = urls
        .slice(1, -1)
        .map((url) => Object.fromEntries(new URL(url).searchParams));
      expect(rungs).toStrictEqual([
        { variant: "thumb", variant_of: HEIC_SHA, media_type: "image/jpeg" },
        { variant: "preview", variant_of: HEIC_SHA, media_type: "image/jpeg" },
        {
          variant: "phash",
          variant_of: HEIC_SHA,
          media_type: "text/x-perceptual-hash",
        },
        {
          variant: "thumbhash",
          variant_of: HEIC_SHA,
          media_type: "application/x-thumbhash",
        },
      ]);

      // The portrait fixture asset fits its LONG edge, as the gateway ladder
      // does. The THIRD render is the ≤100px raster the inline rungs are
      // hashed from — thumbhash throws above 100×100, and the contributed
      // ladder must not be resized to suit it.
      expect(renders.map((render) => render.actions)).toStrictEqual([
        [{ resize: { height: BLOB_TINY_EDGE } }],
        [{ resize: { height: BLOB_MEDIUM_EDGE } }],
        [{ resize: { height: 100 } }],
      ]);
      expect(renders.at(-1)!.shape.height).toBeLessThanOrEqual(100);

      // The inline rungs carry their canonical values, not bytes.
      expect(calls.at(-3)!.body).toMatch(/^[0-9a-f]{16}$/u);
      expect(calls.at(-2)!.body).toMatch(/^[A-Za-z0-9+/]+$/u);

      // Landing is stated, so a run that produced nothing is legible by its
      // absence (logs.md).
      expect(logged).toStrictEqual([
        "[centraid] import: device rungs landed for IMG_0001.HEIC — thumb, preview, phash, thumbhash",
      ]);
      expect(warned).toStrictEqual([]);
    });

    test("a device that cannot render the rungs says so, and still imports", async () => {
      renderFailure = "192x256 doesn't fit in 100x100";
      await expect(
        attemptImportCandidate("http://gw", {
          filename: "IMG_0004.HEIC",
          id: "d",
          kind: "photo",
          localId: "local-d",
        })
      ).resolves.toBe("imported");
      // No variant door was knocked on, and the reason is on the console
      // rather than nowhere at all.
      expect(calls.map((call) => call.url)).toStrictEqual([
        "http://gw/centraid/_vault/imports",
        "http://gw/centraid/_vault/imports/b1/publish",
      ]);
      expect(warned).toStrictEqual([
        "[centraid] import: device rungs skipped for IMG_0004.HEIC — could not render on device: 192x256 doesn't fit in 100x100",
      ]);
      expect(logged).toStrictEqual([]);
    });

    test("a JPEG original is left to the gateway's own ingress contributor", async () => {
      await attemptImportCandidate("http://gw", {
        filename: "IMG_0002.JPG",
        id: "b",
        kind: "photo",
        localId: "local-b",
      });
      expect(calls.map((call) => call.url)).toStrictEqual([
        "http://gw/centraid/_vault/imports",
        "http://gw/centraid/_vault/imports/b1/publish",
      ]);
    });

    test("a rung that will not contribute never fails the import", async () => {
      vi.stubGlobal(
        "fetch",
        (url: string, init: { body?: unknown }): Promise<Response> => {
          calls.push({ url, body: init.body });
          const ok = !url.includes("/blobs");
          return Promise.resolve({
            ok,
            status: ok ? 200 : 500,
            json: () =>
              Promise.resolve(
                url.endsWith("/publish")
                  ? {
                      batchId: "b1",
                      created: 1,
                      updated: 0,
                      skipped: 0,
                      failed: 0,
                    }
                  : {
                      batchId: "b1",
                      staged: { create: 1, update: 0, skip: 0 },
                      unrouted: [],
                    }
              ),
          } as Response);
        }
      );
      await expect(
        attemptImportCandidate("http://gw", {
          filename: "IMG_0003.HEIC",
          id: "c",
          kind: "photo",
          localId: "local-c",
        })
      ).resolves.toBe("imported");
      expect(calls.at(-1)!.url).toBe(
        "http://gw/centraid/_vault/imports/b1/publish"
      );
      // The HTTP status is IN the line: a rejected contribution and an
      // unreachable gateway are different bugs.
      expect(warned).toStrictEqual([
        "[centraid] import: device rungs skipped for IMG_0003.HEIC — contribution failed: Derivative thumb failed (500)",
      ]);
    });
  });
});
