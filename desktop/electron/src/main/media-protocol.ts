/*
 * `centraid://` — the media door (#1020, D-1020-F3).
 *
 * `protocol.handle` in main, answering `Range` requests out of the seat's blob
 * store over the socket. **Local-only, in process, no listener**: there is no
 * loopback port and nothing on the network, which is what replaces v0's
 * `webRequest` `Authorization` injector (census §F5.2) — a subresource load
 * needs no header when the scheme itself is only answerable inside this window.
 *
 * All of the status and header arithmetic is `media-response-core.ts`; the
 * range GRAMMAR is the sidecar's (one copy, `crates/centraid/src/cmd/seat/
 * blob.rs`), and the `Range` header crosses untouched.
 *
 * ## Why this streams rather than answering one frame
 *
 * The socket's frames are capped at 256 KiB, so one `blob_range` answers at
 * most 128 KiB of blob. Answering a request with that one window and an honest
 * `Content-Length` would mean telling a `<video>` the file is 128 KiB long —
 * which it would believe, once, forever. So the seat reports the range it
 * **resolved** (`req_end`) alongside the window it could fit, and the response
 * body is a `ReadableStream` that pulls the remaining windows. The
 * `Content-Length` is the resolved range's length, which is the truth.
 */

import { protocol } from "electron";

import { mediaResponse, parseMediaUrl } from "./media-response-core.js";
import type { SeatBlobAnswer } from "./media-response-core.js";
import type { SeatMessage } from "./seat-client-core.js";

export const SCHEME = "centraid";

/**
 * Register the scheme as privileged. **Before `app.whenReady()`** — Electron
 * reads this table when the first renderer process is created, and a
 * registration after ready is silently ignored, which shows up as a `<video>`
 * that never fires `loadedmetadata` and no error anywhere.
 *
 * `stream: true` is what admits `Range`/`206` at all; `standard: true` gives
 * the scheme a real origin so `<video src>` is not treated as opaque;
 * `supportFetchAPI` lets the renderer `fetch()` a thumbnail; `secure` puts it
 * in a secure context. `bypassCSP` stays **false**: blob bytes may be
 * attacker-authored, and a scheme that bypassed the page's CSP would undo the
 * `sandbox` header the response sets.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: false,
      },
    },
  ]);
}

/** What the handler needs from the seat. */
export interface MediaSeat {
  request: (message: Record<string, unknown>) => Promise<SeatMessage>;
}

/** How long a range read waits for bytes that have not arrived. */
export const BLOB_WAIT_MS = 5000;

/** One window of bytes, with the range the seat resolved around it. */
export interface Window_ {
  start: number;
  end: number;
  /** The last byte of the resolved range, before the frame ceiling. */
  reqEnd: number;
  total: number | null;
  complete: boolean;
  partial: boolean;
  bytes: Uint8Array;
}

/** Translate a seat refusal into the answer the response core understands. */
export function refusalToAnswer(error: unknown): SeatBlobAnswer {
  const code = (error as { code?: string }).code;
  const text = error instanceof Error ? error.message : String(error);
  if (code === "still-arriving") {
    // The seat's message is `<received>/<total>`, which is the only place
    // those two numbers exist together.
    const [received, total] = text
      .replace(/^still-arriving:\s*/u, "")
      .split("/")
      .map((part) => Math.trunc(Number(part)));
    return {
      kind: "still-arriving",
      received: Number.isFinite(received) ? (received as number) : 0,
      total: Number.isFinite(total) ? (total as number) : 0,
      mediaType: "application/octet-stream",
    };
  }
  if (code === "unsatisfiable") {
    const size = Math.trunc(Number(text.replace(/^unsatisfiable:\s*/u, "")));
    return { kind: "unsatisfiable", size: Number.isFinite(size) ? size : 0 };
  }
  return { kind: "not-found" };
}

/** Ask the seat for one window. Throws the seat's own typed error. */
export async function readWindow(
  seat: MediaSeat,
  input: { digest: string; range: string | undefined; waitMs: number }
): Promise<Window_> {
  const message = await seat.request({
    t: "blob_range",
    blob: input.digest,
    ...(input.range === undefined ? {} : { range: input.range }),
    wait_ms: input.waitMs,
  });
  if (message.t !== "blob_bytes") {
    throw Object.assign(new Error("not-found"), { code: "not-found" });
  }
  return {
    start: message["start"] as number,
    end: message["end"] as number,
    reqEnd: message["req_end"] as number,
    total: (message["total"] as number | null) ?? null,
    complete: message["complete"] === true,
    partial: message["partial"] === true,
    bytes: Uint8Array.from(
      Buffer.from(String(message["bytes_b64"] ?? ""), "base64")
    ),
  };
}

/**
 * The body for one resolved range: the first window, then the rest.
 *
 * A window that comes back `still-arriving` mid-stream **errors the stream**
 * rather than padding it: a short read on a media element is a retry, and a
 * zero-padded one is a corrupt frame the element will never ask about again.
 */
export function windowStream(
  seat: MediaSeat,
  input: { digest: string; first: Window_ }
): ReadableStream<Uint8Array> {
  let next = input.first.end + 1;
  let pending: Uint8Array | undefined = input.first.bytes;
  const reqEnd = input.first.reqEnd;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        const chunk = pending;
        pending = undefined;
        controller.enqueue(chunk);
        if (next > reqEnd) controller.close();
        return;
      }
      if (next > reqEnd) {
        controller.close();
        return;
      }
      try {
        const window_ = await readWindow(seat, {
          digest: input.digest,
          range: `bytes=${next}-${reqEnd}`,
          waitMs: BLOB_WAIT_MS,
        });
        next = window_.end + 1;
        controller.enqueue(window_.bytes);
        if (next > reqEnd) controller.close();
      } catch (error) {
        controller.error(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    },
  });
}

/**
 * Install the handler.
 *
 * `seat()` is a getter rather than a connection, because the sidecar can be
 * restarted under a running window and a captured connection would be the one
 * that died.
 */
export function installMediaProtocol(seat: () => MediaSeat | undefined): void {
  protocol.handle(SCHEME, async (request) => {
    const parsed = parseMediaUrl(request.url);
    if (!parsed) {
      // 400 and not 404: the URL is malformed, which is a bug in the page
      // rather than a blob nobody has.
      return new Response("not a centraid blob url", {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const attached = seat();
    if (!attached) {
      return new Response("the seat is not running", {
        status: 503,
        headers: { "Retry-After": "1", "Cache-Control": "no-store" },
      });
    }
    const range = request.headers.get("range") ?? undefined;
    const ifNoneMatch = request.headers.get("if-none-match");

    let first: Window_;
    try {
      first = await readWindow(attached, {
        digest: parsed.digest,
        range,
        waitMs: BLOB_WAIT_MS,
      });
    } catch (error) {
      const response = mediaResponse({
        answer: refusalToAnswer(error),
        digest: parsed.digest,
        download: parsed.download,
        ...(ifNoneMatch ? { ifNoneMatch } : {}),
      });
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }

    const stat = await attached
      .request({ t: "blob_stat", blob: parsed.digest })
      .catch(() => undefined);
    const mediaType =
      stat && typeof stat["media_type"] === "string"
        ? (stat["media_type"] as string)
        : "application/octet-stream";

    const response = mediaResponse({
      answer: {
        kind: "bytes",
        start: first.start,
        // The RESOLVED range, so `Content-Length` and `Content-Range` describe
        // what the body will be and not the first frame of it.
        end: first.reqEnd,
        total: first.total,
        complete: first.complete,
        partial: first.partial,
        mediaType,
      },
      digest: parsed.digest,
      download: parsed.download,
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
    });
    if (!response.body) {
      return new Response(null, {
        status: response.status,
        headers: response.headers,
      });
    }
    return new Response(
      windowStream(attached, { digest: parsed.digest, first }),
      {
        status: response.status,
        headers: response.headers,
      }
    );
  });
}
