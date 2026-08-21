import { afterEach, describe, expect, it, vi } from "vitest";

import type * as TypeImport_oycips from "../../gateway-client-core.js";
import { stageBlob, stageDerivative } from "./blob-staging.js";

// gateway-client-core touches window.CentraidApi at module load and is the one
// choke point both doors route through; stub it and capture the calls.
const { doFetch, readJson } = vi.hoisted(() => ({
  doFetch: vi.fn<typeof TypeImport_oycips.doFetch>(),
  readJson: vi.fn<(res: Response, op: string) => Promise<unknown>>(),
}));
vi.mock(import("../../gateway-client-core.js") as Promise<unknown>, () => ({
  auth: vi.fn<typeof TypeImport_oycips.auth>(async () => ({
    baseUrl: "https://gw.test",
    token: "tok",
  })),
  authHeaders: (token?: string, contentType?: string) => ({
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(contentType ? { "Content-Type": contentType } : {}),
  }),
  doFetch: (baseUrl: string, pathname: string, init: RequestInit) =>
    doFetch(baseUrl, pathname, init),
  readJson: <T>(...args: Parameters<typeof readJson>) =>
    readJson(...args) as Promise<T>,
  VAULT_HEADER: "x-centraid-vault",
}));

function res(
  init: {
    ok?: boolean;
    status?: number;
    body?: unknown;
    headers?: HeadersInit;
  } = {}
) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: async () => init.body ?? {},
  } as unknown as Response;
}

/** The [pathname, init] a given doFetch call was made with. */
function callArgs(index: number): [string, RequestInit] {
  const call = doFetch.mock.calls[index]!;
  return [call[1] as string, call[2] as RequestInit];
}

// jsdom's File does not implement `arrayBuffer()`, so `sha256File` returns
// null for a plain `new File(...)` and the sha-preflight path is skipped. This
// file-like carries `arrayBuffer` (and no `stream`) so the pure-JS
// StreamingSha256 hashes it — exercising the dedupe branch the way a browser
// File would.
function hashableFile(bytes: Uint8Array, name: string, type: string): File {
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

describe("blob staging", () => {
  afterEach(() => {
    doFetch.mockReset();
  });

  it("stageBlob POSTs the file to the authed blob route (no hash)", async () => {
    doFetch.mockResolvedValueOnce(res({ body: { sha256: "deadbeef" } }));
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    const staged = await stageBlob(file, "", { hash: false });

    expect(staged).toStrictEqual({ sha256: "deadbeef" });
    expect(doFetch).toHaveBeenCalledOnce();
    const [pathname, init] = callArgs(0);
    expect(pathname.startsWith("/centraid/_vault/blobs?")).toBe(true);
    expect(pathname).toContain("filename=note.txt");
    expect(pathname).toContain("media_type=text%2Fplain");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("text/plain");
    expect(headers["x-content-sha256"]).toBeUndefined();
    expect(init.body).toBe(file);
  });

  it("stageBlob addresses the named scope, not the shell's focused one", async () => {
    doFetch.mockResolvedValueOnce(res({ body: { sha256: "s" } }));
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    await stageBlob(file, "", { hash: false, scope: "vault-2" });

    const [, init] = callArgs(0);
    expect((init.headers as Record<string, string>)["x-centraid-vault"]).toBe(
      "vault-2"
    );
  });

  it("stageBlob preflights by sha and short-circuits when the CAS already has it", async () => {
    doFetch.mockImplementation(
      async (_base: string, _path: string, init: RequestInit) =>
        init.method === "HEAD"
          ? res({
              headers: {
                "x-centraid-media-type": "image/png",
                "content-length": "2048",
                "x-centraid-content-id": "ci-1",
                "x-centraid-cas-ack": "replicated",
                "x-centraid-custody": "remote-only",
              },
            })
          : res({ body: { sha256: "should-not-post" } })
    );
    const file = hashableFile(new Uint8Array(64), "pic.png", "image/png");

    const staged = await stageBlob(file);

    // One HEAD preflight, no POST.
    expect(doFetch).toHaveBeenCalledOnce();
    const [pathname, init] = callArgs(0);
    expect(init.method).toBe("HEAD");
    expect(pathname).toContain("/centraid/_vault/blobs/_sha/");
    expect(pathname).toContain("byte_size=64");
    expect(staged.alreadyPresent).toBe(true);
    expect(staged.mediaType).toBe("image/png");
    expect(staged.byteSize).toBe(2048);
    expect(staged.existingContentId).toBe("ci-1");
    expect(staged.custody).toBe("remote-only");
  });

  it("stageBlob hashes, misses the preflight, then POSTs with x-content-sha256", async () => {
    doFetch.mockImplementation(
      async (_base: string, _path: string, init: RequestInit) =>
        init.method === "HEAD"
          ? res({ ok: false, status: 404 })
          : res({ body: { sha256: "h" } })
    );
    const file = hashableFile(
      new Uint8Array(8),
      "a.bin",
      "application/octet-stream"
    );

    await stageBlob(file);

    expect(doFetch).toHaveBeenCalledTimes(2);
    const [headPath, headInit] = callArgs(0);
    expect(headInit.method).toBe("HEAD");
    expect(headPath).toContain("/centraid/_vault/blobs/_sha/");
    const [postPath, postInit] = callArgs(1);
    expect(postInit.method).toBe("POST");
    expect(postPath).toContain("sha256=");
    expect(
      (postInit.headers as Record<string, string>)["x-content-sha256"]
    ).toBeTruthy();
  });

  it("stageBlob throws on a refused upload", async () => {
    doFetch.mockResolvedValueOnce(res({ ok: false, status: 507 }));
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await expect(stageBlob(file, "", { hash: false })).rejects.toThrow(
      "upload refused (507)"
    );
  });

  it("stageDerivative POSTs a variant contribution to the blob route", async () => {
    doFetch.mockResolvedValueOnce(res({ body: { sha256: "thumb" } }));
    const blob = new Blob([new Uint8Array(4)], { type: "image/jpeg" });

    const staged = await stageDerivative(
      "parent-sha",
      "thumb",
      blob,
      "image/jpeg"
    );

    expect(staged).toStrictEqual({ sha256: "thumb" });
    const [pathname, init] = callArgs(0);
    expect(pathname).toContain("variant=thumb");
    expect(pathname).toContain("variant_of=parent-sha");
    expect(pathname).toContain("media_type=image%2Fjpeg");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "image/jpeg"
    );
    expect(init.body).toBe(blob);
  });

  it("stageDerivative reports the variant that was refused", async () => {
    doFetch.mockResolvedValueOnce(res({ ok: false, status: 413 }));
    await expect(
      stageDerivative("parent-sha", "poster", new Blob([]))
    ).rejects.toThrow("poster contribution refused (413)");
  });
});
