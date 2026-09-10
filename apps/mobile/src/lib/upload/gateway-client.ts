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
  /**
   * P4 (#1014): the vault these bytes belong to. Sent as `x-centraid-vault`,
   * never in the body — the gateway resolves the data plane from the header,
   * so a queue holding items for two vaults would otherwise stage every one of
   * them into whichever vault the gateway picks by default.
   */
  vaultId?: string;
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
    etag: string,
    vaultId?: string
  ) => Promise<void>;
  complete: (
    sessionId: string,
    parts: readonly MultipartPartReceipt[],
    vaultId?: string
  ) => Promise<SettlementReceipt>;
  /** The settlement the gateway already holds for `sha256`, or undefined.
   *  P22 (#1014): an `alreadyPresent` begin that carried no settlement asks
   *  here rather than fabricating one. */
  settlementFor?: (
    sha256: string,
    vaultId?: string
  ) => Promise<SettlementReceipt | undefined>;
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
  const headers = (vaultId?: string): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json",
    ...options.headers?.(),
    // Per REQUEST, not per queue: one queue holds items for several vaults.
    ...(vaultId ? { "x-centraid-vault": vaultId } : {}),
  });

  async function send<T>(
    path: string,
    method: string,
    body: unknown,
    vaultId?: string
  ): Promise<T> {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: headers(vaultId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    begin: ({ vaultId, ...input }) =>
      send<DirectBeginResult>(
        "/centraid/_vault/blobs/direct",
        "POST",
        input,
        vaultId
      ),
    recordPart: async (sessionId, partNumber, etag, vaultId) => {
      await send<{ completedParts: MultipartPartReceipt[] }>(
        `/centraid/_vault/blobs/direct/${encodeURIComponent(sessionId)}/parts/${partNumber}`,
        "PUT",
        { etag },
        vaultId
      );
    },
    complete: (sessionId, parts, vaultId) =>
      send<SettlementReceipt>(
        `/centraid/_vault/blobs/direct/${encodeURIComponent(sessionId)}/complete`,
        "POST",
        { parts },
        vaultId
      ),
  };
}
