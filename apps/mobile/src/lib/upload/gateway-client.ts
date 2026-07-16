// Client for the gateway's direct-transfer door (#414/#416), served by
// `packages/gateway/src/routes/blob-routes.ts` over
// `packages/vault/src/blob/direct-transfers.ts`.
//
// The device identity the gateway gates on (`AUTHED_DEVICE_HEADER`) is stamped
// server-side from the paired tunnel — it is never sent from here. A tunnel is
// required only for begin/recordPart/complete; the bytes themselves go
// device→S3 on presigned URLs and need no tunnel at all.

export interface MultipartPartReceipt {
  partNumber: number;
  etag: string;
}

export type DirectUploadPlan =
  | { kind: 'single'; url: string }
  | { kind: 'multipart'; uploadId: string; parts: { partNumber: number; url: string }[] };

export interface DirectBeginInput {
  sha256: string;
  plaintextSize: number;
  sealedSize: number;
  partCount: number;
  mediaType?: string;
  filename?: string;
}

export interface DirectBeginResult {
  sessionId?: string;
  /** D10 dedupe: the gateway already holds these bytes; transfer nothing. */
  alreadyPresent: boolean;
  custody: string;
  /** Raw per-blob content key. Response-only — never persisted, never in a URL. */
  keyBase64: string;
  completedParts: MultipartPartReceipt[];
  upload?: DirectUploadPlan;
}

/** The settlement receipt: `{...staged, casAck: 'replicated', custody: 'remote-only'}`. */
export interface SettlementReceipt extends Record<string, unknown> {
  casAck?: string;
  custody?: string;
}

export interface DirectTransferClient {
  begin(input: DirectBeginInput): Promise<DirectBeginResult>;
  recordPart(sessionId: string, partNumber: number, etag: string): Promise<void>;
  complete(sessionId: string, parts: readonly MultipartPartReceipt[]): Promise<SettlementReceipt>;
}

export class DirectTransferError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DirectTransferError';
  }

  /** 4xx other than 408/429 will not fix itself by retrying the same bytes. */
  get terminal(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface DirectTransferClientOptions {
  gatewayBaseUrl: string;
  fetchImpl?: typeof fetch;
  /** Extra request headers (e.g. `Authorization` in manual dev-URL mode). */
  headers?: () => Record<string, string>;
}

export function httpDirectTransferClient(
  options: DirectTransferClientOptions,
): DirectTransferClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.gatewayBaseUrl.replace(/\/+$/, '');
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    accept: 'application/json',
    ...options.headers?.(),
  });

  async function send<T>(path: string, method: string, body: unknown): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new DirectTransferError(
        `${method} ${path} refused (${response.status})`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  return {
    // 200 when alreadyPresent, 201 otherwise; both are `ok`, and the body's
    // own `alreadyPresent` is the signal we act on.
    begin: (input) => send<DirectBeginResult>('/centraid/_vault/blobs/direct', 'POST', input),
    recordPart: async (sessionId, partNumber, etag) => {
      await send<{ completedParts: MultipartPartReceipt[] }>(
        `/centraid/_vault/blobs/direct/${encodeURIComponent(sessionId)}/parts/${partNumber}`,
        'PUT',
        { etag },
      );
    },
    complete: (sessionId, parts) =>
      send<SettlementReceipt>(
        `/centraid/_vault/blobs/direct/${encodeURIComponent(sessionId)}/complete`,
        'POST',
        { parts },
      ),
  };
}
