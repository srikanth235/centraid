import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const moduleUrl = pathToFileURL(
  path.resolve(import.meta.dirname, "../apps/_shared/download-on-demand.ts")
).href;

interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}
type DownloadState =
  | { phase: "idle" }
  | { phase: "fetching"; progress: DownloadProgress }
  | { phase: "ready"; objectUrl: string; bytes: number }
  | { phase: "failed"; reason: string };

interface DownloadOnDemandDeps {
  fetch: typeof fetch;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
}
type FetchSpy = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

const mod = (await import(moduleUrl)) as {
  totalBytesFromHeader: (value: string | null) => number | null;
  shouldStartFetch: (phase: DownloadState["phase"]) => boolean;
  DownloadOnDemand: new (
    url: string,
    deps: DownloadOnDemandDeps
  ) => {
    state: () => DownloadState;
    subscribe: (listener: (state: DownloadState) => void) => () => void;
    start: () => void;
    release: () => void;
  };
};
const { totalBytesFromHeader, shouldStartFetch, DownloadOnDemand } = mod;

describe("totalBytesFromHeader (no fabricated determinism)", () => {
  it("parses a numeric Content-Length", () => {
    expect(totalBytesFromHeader("2048")).toBe(2048);
  });

  it("is null for a missing header", () => {
    expect(totalBytesFromHeader(null)).toBeNull();
  });

  it("is null for a non-numeric or negative header rather than guessing", () => {
    expect(totalBytesFromHeader("chunked")).toBeNull();
    expect(totalBytesFromHeader("-1")).toBeNull();
  });
});

describe("shouldStartFetch (the explicit-act guard)", () => {
  it("allows starting from idle or failed", () => {
    expect(shouldStartFetch("idle")).toBe(true);
    expect(shouldStartFetch("failed")).toBe(true);
  });

  it("refuses a second start mid-flight or after success", () => {
    expect(shouldStartFetch("fetching")).toBe(false);
    expect(shouldStartFetch("ready")).toBe(false);
  });
});

function fakeResponse(
  chunks: Uint8Array[],
  { ok = true, totalBytes }: { ok?: boolean; totalBytes?: number } = {}
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      index += 1;
    },
  });
  const headers = new Headers();
  if (totalBytes !== undefined)
    headers.set("content-length", String(totalBytes));
  return {
    body,
    headers,
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? "OK" : "Not Found",
  } as unknown as Response;
}

describe("DownloadOnDemand", () => {
  let createObjectURL: (blob: Blob) => string;
  let revokeObjectURL: (url: string) => void;

  beforeEach(() => {
    createObjectURL = vi.fn<() => string>(() => "blob:fake-url-1");
    revokeObjectURL = vi.fn<(url: string) => void>(() => undefined);
  });

  it("stays idle until start() is called — never a silent fetch", () => {
    const fetchSpy = vi.fn<FetchSpy>();
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    expect(dl.state()).toStrictEqual({ phase: "idle" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("goes idle → fetching → ready, and produces exactly one object URL", async () => {
    const chunk = new Uint8Array([1, 2, 3, 4]);
    const fetchSpy = vi.fn<FetchSpy>(async () =>
      fakeResponse([chunk], { totalBytes: 4 })
    );
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    const seen: DownloadState["phase"][] = [];
    dl.subscribe((s) => seen.push(s.phase));

    dl.start();
    expect(dl.state().phase).toBe("fetching");

    await vi.waitFor(() => expect(dl.state().phase).toBe("ready"));
    const ready = dl.state();
    if (ready.phase !== "ready") throw new Error("expected ready");
    expect(ready.objectUrl).toBe("blob:fake-url-1");
    expect(ready.bytes).toBe(4);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(seen).toContain("fetching");
    expect(seen).toContain("ready");
  });

  it("reports determinate progress only when Content-Length was present", async () => {
    const chunks = [new Uint8Array(3), new Uint8Array(5)];
    const fetchSpy = vi.fn<FetchSpy>(async () =>
      fakeResponse(chunks, { totalBytes: 8 })
    );
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    const progresses: DownloadProgress[] = [];
    dl.subscribe((s) => {
      if (s.phase === "fetching") progresses.push(s.progress);
    });

    dl.start();
    await vi.waitFor(() => expect(dl.state().phase).toBe("ready"));

    expect(progresses.some((p) => p.totalBytes === 8)).toBe(true);
    expect(
      progresses.every((p) => p.totalBytes === null || p.totalBytes === 8)
    ).toBe(true);
    const last = progresses.at(-1);
    expect(last?.receivedBytes).toBe(8);
  });

  it("never fabricates a total when Content-Length is absent", async () => {
    const fetchSpy = vi.fn<FetchSpy>(async () =>
      fakeResponse([new Uint8Array(2)])
    );
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    const progresses: DownloadProgress[] = [];
    dl.subscribe((s) => {
      if (s.phase === "fetching") progresses.push(s.progress);
    });

    dl.start();
    await vi.waitFor(() => expect(dl.state().phase).toBe("ready"));

    expect(progresses.every((p) => p.totalBytes === null)).toBe(true);
  });

  it("a second start() while fetching is a no-op, not a duplicate request", async () => {
    const fetchSpy = vi.fn<FetchSpy>(async () =>
      fakeResponse([new Uint8Array(1)], { totalBytes: 1 })
    );
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    dl.start();
    dl.start();
    dl.start();
    await vi.waitFor(() => expect(dl.state().phase).toBe("ready"));
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("a non-ok response resolves to failed, not a broken object URL", async () => {
    const fetchSpy = vi.fn<FetchSpy>(async () =>
      fakeResponse([], { ok: false })
    );
    const dl = new DownloadOnDemand("https://gateway.example/blob/missing", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    dl.start();
    await vi.waitFor(() => expect(dl.state().phase).toBe("failed"));
    const failed = dl.state();
    if (failed.phase !== "failed") throw new Error("expected failed");
    expect(failed.reason).toContain("404");
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("start() is allowed again after a failure", async () => {
    let call = 0;
    const fetchSpy = vi.fn<FetchSpy>(async () => {
      call += 1;
      return call === 1
        ? fakeResponse([], { ok: false })
        : fakeResponse([new Uint8Array(1)], { totalBytes: 1 });
    });
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    dl.start();
    await vi.waitFor(() => expect(dl.state().phase).toBe("failed"));
    dl.start();
    await vi.waitFor(() => expect(dl.state().phase).toBe("ready"));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("release() revokes the object URL and returns to idle", async () => {
    const fetchSpy = vi.fn<FetchSpy>(async () =>
      fakeResponse([new Uint8Array(1)], { totalBytes: 1 })
    );
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    dl.start();
    await vi.waitFor(() => expect(dl.state().phase).toBe("ready"));
    dl.release();
    expect(dl.state()).toStrictEqual({ phase: "idle" });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url-1");
  });

  it("release() before any fetch completed is a no-op on object URLs", () => {
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: vi.fn<FetchSpy>() as unknown as typeof fetch,
      revokeObjectURL,
    });
    dl.release();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(dl.state()).toStrictEqual({ phase: "idle" });
  });

  it("a superseded in-flight fetch never resolves to ready (no leaked object URL)", async () => {
    let resolveSlow: ((r: Response) => void) | undefined;
    const slow = new Promise<Response>((resolve) => {
      resolveSlow = resolve;
    });
    const fetchSpy = vi
      .fn<FetchSpy>()
      .mockReturnValueOnce(slow)
      .mockImplementationOnce(async () =>
        fakeResponse([new Uint8Array(1)], { totalBytes: 1 })
      );
    const dl = new DownloadOnDemand("https://gateway.example/blob/1", {
      createObjectURL,
      fetch: fetchSpy as unknown as typeof fetch,
      revokeObjectURL,
    });
    dl.start();
    dl.release(); // abandons the slow fetch, back to idle
    dl.start(); // a fresh fetch, its own generation
    await vi.waitFor(() => expect(dl.state().phase).toBe("ready"));

    resolveSlow?.(fakeResponse([new Uint8Array(9)], { totalBytes: 9 }));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(dl.state().phase).toBe("ready");
    expect(createObjectURL).toHaveBeenCalledOnce();
  });
});
