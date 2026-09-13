/*
 * `centraid://` as pure arithmetic: a request and a seat answer in, an HTTP
 * status and headers out (#1020, D-1020-F3). No `electron`.
 *
 * This replaces v0's `webRequest` header injector (`auth-injector.ts`, census
 * §F5.2). That injector existed because `<img src>` and `<video src>` cannot
 * carry an `Authorization` header, so main added one to every same-origin
 * subresource load. A protocol handler needs no header at all — the scheme IS
 * the authorisation, because only this window's main process can answer it —
 * and the whole class of "did the injector match this URL" bugs disappears.
 *
 * The **representation** rules are ported verbatim from the gateway's
 * `packages/server/src/routes/blob-read-route.ts`, because they are security
 * decisions about attacker-authored bytes and not transport plumbing:
 * `Accept-Ranges`, the immutable private cache policy, `nosniff`, the `sandbox`
 * CSP, and the three media types that are never inline (issue #865).
 *
 * The range GRAMMAR is deliberately **not** here: it lives once, in the
 * sidecar (`crates/centraid/src/cmd/seat/blob.rs`), and this module passes the
 * `Range` header through untouched. Two copies of that grammar is how
 * `bytes=-10` starts meaning different things at each end.
 */

/** Never served inline. v0's `INLINE_EXECUTABLE_MEDIA_TYPES`. */
export const INLINE_EXECUTABLE_MEDIA_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
] as const;

export function baseMediaType(mediaType: string): string {
  return (mediaType.split(";")[0] ?? "").trim().toLowerCase();
}

export function mayServeInline(mediaType: string): boolean {
  return !(INLINE_EXECUTABLE_MEDIA_TYPES as readonly string[]).includes(
    baseMediaType(mediaType)
  );
}

/** What the URL asked for. */
export interface ParsedMediaUrl {
  digest: string;
  /** `?download=1` forces an attachment even for an inline-safe type. */
  download: boolean;
}

/**
 * Parse a `centraid://blob/<digest>` URL.
 *
 * The digest is checked HERE, before anything is asked of the seat, and the
 * check is the same sixty-four-hex-characters rule the vault's `sha256` column
 * carries (`vault-ddl.sql:1566`). v0's equivalent lesson is `parseRevealableAppId`
 * being applied *before any path join* because an appId reached `shell.openPath`
 * (census §F4); the same discipline, one layer earlier.
 */
export function parseMediaUrl(url: string): ParsedMediaUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "centraid:") return null;
  // `centraid://blob/<digest>`: the host is `blob`, the path is the digest.
  // A second route may be added later, which is why the host is matched rather
  // than ignored.
  if (parsed.hostname !== "blob") return null;
  const digest = parsed.pathname.replace(/^\/+/u, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(digest)) return null;
  return {
    digest,
    download: parsed.searchParams.get("download") === "1",
  };
}

/** What the seat answered for a range read. */
export type SeatBlobAnswer =
  | {
      kind: "bytes";
      start: number;
      end: number;
      total: number | null;
      complete: boolean;
      /** Whether the client sent a `Range` header. */
      partial: boolean;
      mediaType: string;
    }
  | {
      kind: "still-arriving";
      received: number;
      total: number;
      mediaType: string;
    }
  | { kind: "unsatisfiable"; size: number }
  | { kind: "not-found" };

export interface MediaResponse {
  status: number;
  headers: Record<string, string>;
  /** Whether the caller should attach the seat's bytes as the body. */
  body: boolean;
}

/**
 * Build the response for one answer.
 *
 * Three statuses and no fourth:
 *
 * - `200` — no `Range` was asked for.
 * - `206` — a `Range` was asked for, and `Content-Range` says what was served.
 *   A short answer is still a `206`: an arriving blob and a frame ceiling both
 *   produce one, and short is what every range server does.
 * - `416` — only for a blob whose size is **settled**.
 * - `503` with `Retry-After` — the range is inside a declared total whose bytes
 *   have not landed. NOT a `416` (D-1020-F3): a `416` means "that range does
 *   not exist" and a media element that gets one stops asking, permanently.
 *   `503` means "ask again", which is true.
 */
export function mediaResponse(input: {
  answer: SeatBlobAnswer;
  digest: string;
  download: boolean;
  ifNoneMatch?: string;
}): MediaResponse {
  const etag = `"${input.digest}"`;
  if (input.answer.kind === "not-found") {
    return {
      status: 404,
      headers: { "Cache-Control": "no-store", "Content-Type": "text/plain" },
      body: false,
    };
  }
  if (input.answer.kind === "unsatisfiable") {
    return {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${input.answer.size}`,
        "Cache-Control": "no-store",
      },
      body: false,
    };
  }
  if (input.answer.kind === "still-arriving") {
    return {
      status: 503,
      headers: {
        "Accept-Ranges": "bytes",
        // Diagnostic, not a satisfied range: it tells a human reading the
        // network panel what the blob's real size is while it lands.
        "Content-Range": `bytes */${input.answer.total}`,
        "Retry-After": "1",
        "Cache-Control": "no-store",
        "X-Centraid-Received": String(input.answer.received),
      },
      body: false,
    };
  }

  const answer = input.answer;
  const inline = !input.download && mayServeInline(answer.mediaType);
  const headers: Record<string, string> = {
    ETag: etag,
    "Accept-Ranges": "bytes",
    // Content-addressed bytes never change under their digest — cache forever,
    // privately, because this is the owner's data.
    //
    // ONLY ONCE COMPLETE. An arriving blob's prefix answered `immutable` is a
    // truncated video cached forever, which is the one cache bug that survives
    // a restart.
    "Cache-Control": answer.complete
      ? "private, max-age=31536000, immutable"
      : "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Content-Type": answer.mediaType,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filenameFor(
      input.digest
    )}"`,
  };

  // A CONDITIONAL REQUEST is only honourable against a settled representation:
  // "not modified" about a blob that is still growing is a lie.
  if (input.ifNoneMatch === etag && answer.complete) {
    return {
      status: 304,
      headers: {
        ETag: etag,
        "Accept-Ranges": "bytes",
        "Cache-Control": headers["Cache-Control"] as string,
      },
      body: false,
    };
  }

  const length = answer.end - answer.start + 1;
  if (answer.partial) {
    const total = answer.total ?? answer.end + 1;
    return {
      status: 206,
      headers: {
        ...headers,
        "Content-Range": `bytes ${answer.start}-${answer.end}/${total}`,
        "Content-Length": String(length),
      },
      body: true,
    };
  }
  return {
    status: 200,
    headers: { ...headers, "Content-Length": String(length) },
    body: true,
  };
}

/**
 * The filename in `Content-Disposition`.
 *
 * The digest's first twelve characters, and nothing the member typed: v0 strips
 * quotes, backslashes and newlines out of a title before it reaches this header
 * (`blob-read-route.ts:49`–`:52`), and a header the shell builds from a digest
 * has nothing to strip. A title belongs in the UI, where it cannot become a
 * header injection.
 */
export function filenameFor(digest: string): string {
  return digest.slice(0, 12);
}
