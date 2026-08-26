// Test-only server-side model of direct transfer (`blob/direct-transfers.ts` + S3) plus a killer
// that stops the world at any seam — sha-keyed resume replays completedParts, replicated shas
// short-circuit, killed PUT stores nothing. Never imported by app code.

/* oxlint-disable max-classes-per-file -- (#419) the kill switch, the provider
   and the gateway are one test model of a single contract: the killer's step
   labels are named by the provider/gateway seams they instrument, and splitting
   them would scatter one fixture across four files. */

import { createHash } from "node:crypto";

import type {
  DirectBeginInput,
  DirectBeginResult,
  DirectTransferClient,
  MultipartPartReceipt,
  SettlementReceipt,
} from "../../src/lib/upload/gateway-client";
import { DirectTransferError } from "../../src/lib/upload/gateway-client";

export const FAKE_ENDPOINT = "https://s3.example.test";
export const FAKE_BUCKET = "centraid-blobs";
export const FAKE_PREFIX = "vault1";
export const FAKE_UPLOAD_PREFIX = `/${FAKE_BUCKET}/${FAKE_PREFIX}/tmp/blobs/`;
export const FAKE_GATEWAY = "https://gateway.example.test";

/** Thrown to simulate process death; never swallow it. */
export class UploadKillSignalError extends Error {
  constructor(readonly at: string) {
    super(`process killed at ${at}`);
    this.name = "UploadKillSignalError";
  }
}

export class Killer {
  budget = Number.POSITIVE_INFINITY;
  readonly seen: string[] = [];

  step(label: string): void {
    this.seen.push(label);
    if (this.budget <= 0) throw new UploadKillSignalError(label);
    this.budget -= 1;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface FakeSession {
  sessionId: string;
  sha256: string;
  tempId: string;
  uploadId: string;
  partCount: number;
  plaintextSize: number;
  sealedSize: number;
  recorded: Map<number, string>;
}

/** Objects appear only on a completed PUT. */
export class FakeProvider {
  readonly parts = new Map<string, Uint8Array>(); // `${tempId}/${partNumber}` → sealed bytes
  readonly cas = new Map<string, Uint8Array>(); // sha → committed CAS object
  readonly putLog: { tempId: string; partNumber: number; etag: string }[] = [];

  constructor(private readonly killer: Killer) {}

  async put(url: string, body: Uint8Array): Promise<string> {
    const target = new URL(url);
    const tempId = target.pathname.split("/").pop()!;
    const partNumber = Number(target.searchParams.get("partNumber") ?? "1");
    // Connection may die mid-PUT; a partial PUT stores nothing.
    const stride = Math.max(1, Math.ceil(body.byteLength / 4));
    for (let offset = 0; offset < body.byteLength; offset += stride) {
      this.killer.step(`put:${partNumber}:byte${offset}`);
    }
    const etag = `"${sha256Hex(body)}"`;
    this.parts.set(`${tempId}/${partNumber}`, body.slice());
    this.putLog.push({ tempId, partNumber, etag });
    // Bytes durable at the provider; client may never learn the ETag.
    this.killer.step(`put-stored:${partNumber}`);
    return etag;
  }
}

export class FakeGateway implements DirectTransferClient {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly bySha = new Map<string, string>();
  private counter = 0;
  private readonly keys = new Map<string, Uint8Array>();
  readonly completeLog: string[] = [];

  constructor(
    readonly provider: FakeProvider,
    private readonly killer: Killer
  ) {}

  keyFor(sha256: string): Uint8Array {
    let key = this.keys.get(sha256);
    if (!key) {
      key = new Uint8Array(
        createHash("sha256").update(`key:${sha256}`).digest()
      );
      this.keys.set(sha256, key);
    }
    return key;
  }

  private urlFor(tempId: string, partNumber: number): string {
    return (
      `${FAKE_ENDPOINT}/${FAKE_BUCKET}/${FAKE_PREFIX}/tmp/blobs/${tempId}` +
      `?partNumber=${partNumber}&X-Amz-Expires=900&X-Amz-Signature=${partNumber}deadbeef`
    );
  }

  async begin(input: DirectBeginInput): Promise<DirectBeginResult> {
    this.killer.step(`begin:${input.sha256.slice(0, 8)}`);
    const keyBase64 = Buffer.from(this.keyFor(input.sha256)).toString("base64");

    if (this.provider.cas.has(input.sha256)) {
      return {
        alreadyPresent: true,
        custody: "remote-only",
        keyBase64,
        completedParts: [],
        // Remote-only is genuinely replicated; client persists it verbatim.
        settlement: {
          alreadyPresent: true,
          sha256: input.sha256,
          casAck: "replicated",
          custody: "remote-only",
          acknowledged: true,
          byteSize: input.plaintextSize,
        },
      };
    }
    const existingId = this.bySha.get(input.sha256);
    const session =
      existingId === undefined
        ? this.open(input)
        : (this.sessions.get(existingId) as FakeSession);
    const completedParts: MultipartPartReceipt[] = [
      ...session.recorded.entries(),
    ]
      .map(([partNumber, etag]) => ({ partNumber, etag }))
      .sort((a, b) => a.partNumber - b.partNumber);
    const missing = Array.from(
      { length: session.partCount },
      (_, index) => index + 1
    ).filter((partNumber) => !session.recorded.has(partNumber));
    return {
      sessionId: session.sessionId,
      alreadyPresent: false,
      custody: "pending-offsite",
      keyBase64,
      completedParts,
      upload: {
        kind: "multipart",
        uploadId: session.uploadId,
        parts: missing.map((partNumber) => ({
          partNumber,
          url: this.urlFor(session.tempId, partNumber),
        })),
      },
    };
  }

  private open(input: DirectBeginInput): FakeSession {
    this.counter += 1;
    const sessionId = `session-${this.counter}`;
    const session: FakeSession = {
      sessionId,
      sha256: input.sha256,
      tempId: `direct-${sessionId}`,
      uploadId: `upload-${this.counter}`,
      partCount: input.partCount,
      plaintextSize: input.plaintextSize,
      sealedSize: input.sealedSize,
      recorded: new Map(),
    };
    this.sessions.set(sessionId, session);
    this.bySha.set(input.sha256, sessionId);
    return session;
  }

  async recordPart(
    sessionId: string,
    partNumber: number,
    etag: string
  ): Promise<void> {
    // Killing HERE: provider has bytes, queue has ETag, gateway never heard.
    this.killer.step(`record:${partNumber}`);
    const session = this.require(sessionId);
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.partCount
    ) {
      throw new DirectTransferError(
        `part ${partNumber} is outside the session range`,
        400
      );
    }
    if (!etag) throw new DirectTransferError("multipart ETag is required", 400);
    session.recorded.set(partNumber, etag);
    this.killer.step(`record-done:${partNumber}`);
  }

  async complete(
    sessionId: string,
    parts: readonly MultipartPartReceipt[]
  ): Promise<SettlementReceipt> {
    this.killer.step("complete");
    const session = this.require(sessionId);
    for (const part of parts) session.recorded.set(part.partNumber, part.etag);
    if (session.recorded.size !== session.partCount) {
      throw new DirectTransferError(
        `completion has ${session.recorded.size}/${session.partCount} part receipts`,
        400
      );
    }
    const assembled: Uint8Array[] = [];
    for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
      const bytes = this.provider.parts.get(`${session.tempId}/${partNumber}`);
      if (!bytes)
        throw new DirectTransferError(
          `provider is missing part ${partNumber}`,
          400
        );
      const declared = session.recorded.get(partNumber)!;
      // Mismatch = client recorded a part it never uploaded.
      if (declared !== `"${sha256Hex(bytes)}"`) {
        throw new DirectTransferError(
          `part ${partNumber} ETag does not match stored bytes`,
          400
        );
      }
      assembled.push(bytes);
    }
    const object = Buffer.concat(assembled);
    if (object.byteLength !== session.sealedSize) {
      throw new DirectTransferError(
        `sealed size mismatch: expected ${session.sealedSize}, got ${object.byteLength}`,
        400
      );
    }
    this.provider.cas.set(session.sha256, new Uint8Array(object));
    this.sessions.delete(sessionId);
    this.bySha.delete(session.sha256);
    this.completeLog.push(session.sha256);
    // Killing HERE: CAS commits, client never learns the receipt.
    this.killer.step("complete-done");
    return {
      sha256: session.sha256,
      byteSize: session.plaintextSize,
      casAck: "replicated",
      custody: "remote-only",
    };
  }

  private require(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new DirectTransferError(
        `unknown or closed session ${sessionId}`,
        409
      );
    return session;
  }
}

/** Serves what `assertGatewayMintedUploadUrl` allowlists from, so real policy code runs. */
export function fakeBlobStoreFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const href = typeof input === "string" ? input : input.toString();
    if (href.endsWith("/centraid/_vault/blob-store")) {
      return new Response(
        JSON.stringify({
          blob_store: {
            kind: "s3",
            endpoint: FAKE_ENDPOINT,
            // Mirrors the route's allowlist-root derivation; not imported.
            bucket: FAKE_BUCKET,
            prefix: FAKE_PREFIX,
            allowedUploadPrefix: FAKE_UPLOAD_PREFIX,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected fetch in test: ${href}`);
  }) as typeof fetch;
}
