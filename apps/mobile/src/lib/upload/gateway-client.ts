// Direct-transfer client (#414/#416); identity is stamped server-side from
// the tunnel, never sent here.

export interface MultipartPartReceipt {
  partNumber: number;
  etag: string;
}

export type DirectUploadPlan =
  | { kind: "single"; url: string }
  | {
      kind: "multipart";
      uploadId: string;
      parts: { partNumber: number; url: string }[];
    };

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
  /** D10 dedupe: the gateway already holds these bytes. */
  alreadyPresent: boolean;
  custody: string;
  /** Raw content key — response-only; never persisted, never in a URL. */
  keyBase64: string;
  completedParts: MultipartPartReceipt[];
  /** Authoritative settlement iff `alreadyPresent`; persist verbatim,
   *  NEVER fabricate a `casAck`. */
  settlement?: SettlementReceipt;
  upload?: DirectUploadPlan;
}

export interface SettlementReceipt extends Record<string, unknown> {
  casAck?: string;
  custody?: string;
}

export interface DirectTransferClient {
  begin: (input: DirectBeginInput) => Promise<DirectBeginResult>;
  recordPart: (
    sessionId: string,
    partNumber: number,
    etag: string
  ) => Promise<void>;
  complete: (
    sessionId: string,
    parts: readonly MultipartPartReceipt[]
  ) => Promise<SettlementReceipt>;
}

export class DirectTransferError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "DirectTransferError";
  }

  /** 4xx other than 408/429 will not fix itself by retrying. */
  get terminal(): boolean {
    return (
      this.status >= 400 &&
      this.status < 500 &&
      this.status !== 408 &&
      this.status !== 429
    );
  }
}

export interface DirectTransferClientOptions {
  gatewayBaseUrl: string;
  fetchImpl?: typeof fetch;
  headers?: () => Record<string, string>;
}

export function httpDirectTransferClient(
  options: DirectTransferClientOptions
): DirectTransferClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.gatewayBaseUrl.replace(/\/+$/u, "");
  const headers = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json",
    ...options.headers?.(),
  });

  async function send<T>(
    path: string,
    method: string,
    body: unknown
  ): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new DirectTransferError(
        `${method} ${path} refused (${response.status})`,
        response.status
      );
    }
    return (await response.json()) as T;
  }

  return {
    begin: (input) =>
      send<DirectBeginResult>("/centraid/_vault/blobs/direct", "POST", input),
    recordPart: async (sessionId, partNumber, etag) => {
      await send<{ completedParts: MultipartPartReceipt[] }>(
        `/centraid/_vault/blobs/direct/${encodeURIComponent(sessionId)}/parts/${partNumber}`,
        "PUT",
        { etag }
      );
    },
    complete: (sessionId, parts) =>
      send<SettlementReceipt>(
        `/centraid/_vault/blobs/direct/${encodeURIComponent(sessionId)}/complete`,
        "POST",
        { parts }
      ),
  };
}
