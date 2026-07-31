// Laws for the paired-device direct CAS reader (#414 D11/D12) — the module had
// no test file (#656 Layer 1B). This is the seam where ciphertext travels
// provider → device WITHOUT passing through the gateway, so the laws are about
// what the client refuses to trust: a provider that will not serve ranges, an
// object that is not CBSF v2, a header whose identity disagrees with the digest
// the caller asked for, and a plaintext size that disagrees with the sealed
// directory. The bounded-egress law is the reason the module exists at all —
// frames are ranged one at a time, so the whole object is never in memory.

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CBSF_HEADER_BYTES,
  CBSF_MAGIC,
  CBSF_NONCE_BYTES,
  CBSF_TRAILER_BYTES,
  CBSF_VERSION,
  cbsfDirectoryAad,
  cbsfFrameAad,
  encodeCbsfDirectory,
} from "@centraid/blob-format";

import { readDirectBlob } from "./device-blob-source.js";

const SHA = "ab".repeat(32);
const URL_ = "https://provider.test/o/1";
const RAW_KEY = new Uint8Array(32).fill(7);

/** Range headers the client asked the provider for, in order. */
let ranges: string[] = [];

function ascii(value: string): Uint8Array {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from({ length: hex.length / 2 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  );
}

async function importKey(usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    RAW_KEY.slice().buffer,
    { name: "AES-GCM" },
    false,
    [usage]
  );
}

/** Seal with a fixed nonce — determinism matters more than nonce hygiene here. */
async function seal(
  plain: Uint8Array,
  additionalData: string,
  nonceSeed: number
): Promise<Uint8Array> {
  const iv = new Uint8Array(CBSF_NONCE_BYTES).fill(nonceSeed);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(additionalData),
        tagLength: 128,
      },
      await importKey("encrypt"),
      plain.slice().buffer
    )
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return out;
}

interface CbsfOptions {
  sha?: string;
  magic?: string;
  version?: number;
  algorithm?: number;
  totalSizeOverride?: number;
}

/** Build a real CBSF v2 object: header | frames | sealed directory | trailer. */
async function buildCbsf(
  payloads: Uint8Array[],
  options: CbsfOptions = {}
): Promise<Uint8Array> {
  const sha = options.sha ?? SHA;
  const frameCount = payloads.length;
  const sealedFrames = await Promise.all(
    payloads.map((payload, index) => {
      const body = new Uint8Array(payload.length + 1);
      body[0] = options.algorithm ?? 0;
      body.set(payload, 1);
      return seal(body, cbsfFrameAad(sha, index, frameCount), index + 1);
    })
  );
  const totalSize =
    options.totalSizeOverride ??
    payloads.reduce((sum, payload) => sum + payload.length, 0);
  const directory = await seal(
    encodeCbsfDirectory(
      payloads[0]?.length ?? 0,
      totalSize,
      sealedFrames.map((frame) => frame.length)
    ),
    cbsfDirectoryAad(sha, frameCount),
    200
  );

  const header = new Uint8Array(CBSF_HEADER_BYTES);
  header.set(ascii(options.magic ?? CBSF_MAGIC));
  header[4] = options.version ?? CBSF_VERSION;
  header.set(hexBytes(sha), 5);
  const trailer = new Uint8Array(CBSF_TRAILER_BYTES);
  trailer.set(ascii(options.magic ?? CBSF_MAGIC));
  trailer[4] = options.version ?? CBSF_VERSION;
  const trailerView = new DataView(trailer.buffer);
  trailerView.setUint32(5, directory.length, false);
  trailerView.setUint32(9, frameCount, false);

  const parts = [header, ...sealedFrames, directory, trailer];
  const object = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    object.set(part, offset);
    offset += part.length;
  }
  return object;
}

/** A provider that honors ranges. `mangle` models a misbehaving one. */
function stubProvider(
  object: Uint8Array,
  mangle?: (range: string, body: Uint8Array) => Response
): void {
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers as HeadersInit | undefined).get(
      "Range"
    ) as string;
    ranges.push(range);
    const suffix = /^bytes=-(?<len>\d+)$/u.exec(range);
    const span = /^bytes=(?<start>\d+)-(?<end>\d+)$/u.exec(range);
    const start = suffix
      ? object.length - Number(suffix.groups?.len)
      : Number(span?.groups?.start);
    const end = suffix ? object.length - 1 : Number(span?.groups?.end);
    const body = object.slice(start, end + 1);
    if (mangle) return Promise.resolve(mangle(range, body));
    return Promise.resolve(
      new Response(body.slice().buffer, {
        status: 206,
        headers: {
          "content-range": `bytes ${start}-${end}/${object.length}`,
        },
      })
    );
  });
}

describe("direct provider blob seam", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    ranges = [];
  });

  it("law: a sealed object round-trips to the caller's bytes and media type", async () => {
    const payloads = [ascii("hello "), ascii("world")];
    stubProvider(await buildCbsf(payloads));

    const blob = await readDirectBlob(
      { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
      SHA,
      "text/plain"
    );

    await expect(blob.text()).resolves.toBe("hello world");
    expect(blob.type).toBe("text/plain");
  });

  it("law: bytes arrive frame by frame — the object is never ranged whole", async () => {
    stubProvider(await buildCbsf([ascii("a"), ascii("b"), ascii("c")]));

    await readDirectBlob(
      { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
      SHA,
      "text/plain"
    );

    expect(ranges).toHaveLength(6);
    expect(ranges[0]).toBe(`bytes=-${CBSF_TRAILER_BYTES}`);
    expect(ranges[1]).toBe(`bytes=0-${CBSF_HEADER_BYTES - 1}`);
    expect(ranges.some((range) => range === "bytes=0-")).toBe(false);
  });

  it("law: a direct read demands a full digest before it touches the provider", async () => {
    stubProvider(await buildCbsf([ascii("a")]));

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        "not-a-digest",
        "text/plain"
      )
    ).rejects.toThrow(/needs sha256/u);
    expect(ranges).toStrictEqual([]);
  });

  it("law: a provider that will not serve ranges is refused", async () => {
    stubProvider(
      await buildCbsf([ascii("a")]),
      (_range, body) => new Response(body.slice().buffer, { status: 200 })
    );

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        SHA,
        "text/plain"
      )
    ).rejects.toThrow(/did not honor CBSF range read/u);
  });

  it("law: a provider that hides Content-Range cannot be trusted for offsets", async () => {
    stubProvider(
      await buildCbsf([ascii("a")]),
      (_range, body) => new Response(body.slice().buffer, { status: 206 })
    );

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        SHA,
        "text/plain"
      )
    ).rejects.toThrow(/did not expose Content-Range/u);
  });

  it("law: an object that is not CBSF v2 is refused before any frame is opened", async () => {
    stubProvider(await buildCbsf([ascii("a")], { version: 1 }));

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        SHA,
        "text/plain"
      )
    ).rejects.toThrow(/not CBSF v2/u);
    expect(ranges).toStrictEqual([`bytes=-${CBSF_TRAILER_BYTES}`]);
  });

  it("law: the sealed header must claim the SAME identity the caller asked for", async () => {
    stubProvider(await buildCbsf([ascii("a")], { sha: "cd".repeat(32) }));

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        SHA,
        "text/plain"
      )
    ).rejects.toThrow(/header identity mismatch/u);
  });

  it("law: a provider that lies about the object size is refused before any decrypt", async () => {
    stubProvider(
      await buildCbsf([ascii("a")]),
      (_range, body) =>
        new Response(body.slice().buffer, {
          status: 206,
          headers: { "content-range": `bytes 0-0/${body.length}` },
        })
    );

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        SHA,
        "text/plain"
      )
    ).rejects.toThrow(/directory offset is invalid/u);
  });

  it("law: a compression algorithm the browser cannot open is named, not guessed", async () => {
    stubProvider(await buildCbsf([ascii("a")], { algorithm: 7 }));

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        SHA,
        "text/plain"
      )
    ).rejects.toThrow(/cannot open CBSF compression algorithm 7/u);
  });

  it("law: plaintext that disagrees with the sealed directory is a size mismatch", async () => {
    stubProvider(await buildCbsf([ascii("hello")], { totalSizeOverride: 999 }));

    await expect(
      readDirectBlob(
        { url: URL_, keyBase64: btoa(String.fromCharCode(...RAW_KEY)) },
        SHA,
        "text/plain"
      )
    ).rejects.toThrow(/plaintext size mismatch/u);
  });
});
