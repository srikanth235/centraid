// A fake enrichment service for tests (issue #724 W1).
//
// The enrichment service is a WIRE contract, not an interface — a loopback
// HTTP server this gateway does not own, whose every answer is foreign input —
// so the tests that mean anything drive a real socket rather than a stubbed
// function. Standing one up is fiddly enough (ephemeral port, body caps,
// deliberate misbehaviours, socket teardown that does not wedge `close`) that
// every suite touching enrichment would otherwise carry its own copy. It lives
// here, beside the client it stands in for, and the sweep suites import it.
//
// IT MISBEHAVES ON PURPOSE. A local service written by someone else is the
// thing most likely to hang, truncate, or answer four results to a three-item
// ask, and the client's caps exist for exactly those cases — so they are
// configurable here rather than merely imagined in a comment.
//
// Vectors are DETERMINISTIC and derived from the payload (`fakeVectorFor`), so
// a test that controls a photograph's derivative bytes controls its vector
// exactly and can predict a ranking by hand.

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type {
  EnrichCapability,
  EnrichServiceConfig,
} from "./service-client.js";

/** Dimension of every vector the fake produces — small, so fixtures are readable. */
export const FAKE_DIM = 4;

/**
 * The vector the fake returns for a payload: the first `FAKE_DIM` bytes scaled
 * into [0,1]. Cosine ranking over such vectors is predictable by inspection.
 */
export function fakeVectorFor(payload: Buffer | string): number[] {
  const bytes = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload, "utf8");
  return Array.from({ length: FAKE_DIM }, (_, i) => (bytes[i] ?? 0) / 255);
}

/**
 * How a capability's POST goes wrong instead of answering. Each one is a
 * failure mode the client claims to survive:
 *
 *   `hang`          — never responds (the client's own timeout must fire)
 *   `server-error`  — HTTP 500
 *   `unavailable`   — HTTP 404 {"error":"unavailable"} (not advertised)
 *   `truncated-json`— a body that stops mid-object
 *   `oversize`      — a body past the client's 32 MB ceiling
 *   `wrong-count`   — fewer results than items
 *   `bad-model`     — a model id that is not "<name>@<version>"
 */
export type FakeEnrichMisbehaviour =
  | "hang"
  | "server-error"
  | "unavailable"
  | "truncated-json"
  | "oversize"
  | "wrong-count"
  | "bad-model";

export interface FakeCapabilityBehaviour {
  /** Advertised model id. Unparseable values are legal — that is a test case. */
  model?: string;
  /**
   * The canned payload for one item, WITHOUT its id (the server stamps that).
   * Return `{error}` to exercise a per-item failure.
   */
  result?: (item: Record<string, unknown>, index: number) => unknown;
  misbehave?: FakeEnrichMisbehaviour;
}

export interface FakeEnrichServiceOptions {
  /**
   * Which capabilities exist, and how each behaves. Omitted entirely means
   * "all five, well-behaved"; naming a subset means the others are genuinely
   * absent — `GET /capabilities` omits them and their POST answers 404.
   */
  capabilities?: Partial<Record<EnrichCapability, FakeCapabilityBehaviour>>;
  /** When set, requests without this bearer token are 401. */
  token?: string;
  /** Misbehaviour of `GET /capabilities` itself. */
  probe?: Extract<
    FakeEnrichMisbehaviour,
    "hang" | "server-error" | "truncated-json"
  >;
}

export interface FakeEnrichCall {
  capability: string;
  items: Record<string, unknown>[];
}

export interface FakeEnrichService {
  /** Ready to hand straight to `enrichBatch` / `probeEnrichService`. */
  config: EnrichServiceConfig;
  /** Every `/enrich/<cap>` POST the client made, in order. */
  calls: FakeEnrichCall[];
  /** How many times `GET /capabilities` was asked. */
  probes: () => number;
  close: () => Promise<void>;
}

const DEFAULT_MODELS: Record<EnrichCapability, string> = {
  "embed-image": "fake-clip@1",
  "embed-text": "fake-clip@1",
  ocr: "fake-ocr@1",
  faces: "fake-faces@1",
  transcript: "fake-asr@1",
};

/** Well-behaved answers: the shape the wire contract documents, nothing more. */
const DEFAULT_RESULTS: Record<
  EnrichCapability,
  (item: Record<string, unknown>) => unknown
> = {
  "embed-image": (item) => ({
    vector: fakeVectorFor(Buffer.from(String(item["bytes"]), "base64")),
  }),
  "embed-text": (item) => ({ vector: fakeVectorFor(String(item["text"])) }),
  ocr: () => ({ regions: [] }),
  faces: () => ({ faces: [] }),
  transcript: (item) => ({ text: `transcript of ${String(item["id"])}` }),
};

const ALL: EnrichCapability[] = [
  "embed-image",
  "embed-text",
  "ocr",
  "faces",
  "transcript",
];

/** One mebibyte of filler, reused so `oversize` costs the test no memory. */
const FILLER = Buffer.alloc(1024 * 1024, 0x61);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
  });
  res.end(payload);
}

function sendOversize(res: ServerResponse): void {
  // No content-length: the client must survive a body that only reveals its
  // size by arriving, which is the case its streaming ceiling exists for.
  res.writeHead(200, { "content-type": "application/json" });
  res.write('{"model":"fake@1","results":["');
  for (let i = 0; i < 33; i += 1) res.write(FILLER);
  res.end('"]}');
}

async function readBody(
  req: IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * Start the fake on 127.0.0.1 with an ephemeral port. Always `await close()`
 * in a cleanup: a `hang` case leaves a live socket, and this is what destroys
 * it rather than letting the suite wait out the client's timeout.
 */
export async function startFakeEnrichService(
  options: FakeEnrichServiceOptions = {}
): Promise<FakeEnrichService> {
  const configured: Partial<Record<EnrichCapability, FakeCapabilityBehaviour>> =
    options.capabilities ?? Object.fromEntries(ALL.map((cap) => [cap, {}]));
  const calls: FakeEnrichCall[] = [];
  const sockets = new Set<Socket>();
  let probes = 0;

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  function authorized(req: IncomingMessage): boolean {
    if (!options.token) return true;
    return req.headers.authorization === `Bearer ${options.token}`;
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    if (!authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const path = new URL(req.url ?? "/", "http://fake.local").pathname;
    if (path.endsWith("/capabilities")) {
      probes += 1;
      handleProbe(res);
      return;
    }
    const capability = path.slice(path.lastIndexOf("/") + 1);
    void handleEnrich(req, res, capability);
  }

  function handleProbe(res: ServerResponse): void {
    if (options.probe === "hang") return;
    if (options.probe === "server-error") {
      sendJson(res, 500, { error: "boom" });
      return;
    }
    if (options.probe === "truncated-json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"capabilities": {"embed-text"');
      return;
    }
    sendJson(res, 200, {
      capabilities: Object.fromEntries(
        Object.entries(configured).map(([capability, behaviour]) => [
          capability,
          {
            model:
              behaviour.model ?? DEFAULT_MODELS[capability as EnrichCapability],
          },
        ])
      ),
    });
  }

  async function handleEnrich(
    req: IncomingMessage,
    res: ServerResponse,
    capability: string
  ): Promise<void> {
    const behaviour = configured[capability as EnrichCapability];
    if (!behaviour || behaviour.misbehave === "unavailable") {
      sendJson(res, 404, { error: "unavailable" });
      return;
    }
    const body = await readBody(req);
    const items = (body["items"] ?? []) as Record<string, unknown>[];
    calls.push({ capability, items });
    if (behaviour.misbehave === "hang") return;
    if (behaviour.misbehave === "server-error") {
      sendJson(res, 500, { error: "boom" });
      return;
    }
    if (behaviour.misbehave === "oversize") {
      sendOversize(res);
      return;
    }
    if (behaviour.misbehave === "truncated-json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"model":"fake@1","results":[{"id"');
      return;
    }
    const make =
      behaviour.result ??
      DEFAULT_RESULTS[capability as EnrichCapability] ??
      (() => ({}));
    const results = items.map((item, index) => ({
      id: item["id"],
      ...(make(item, index) as Record<string, unknown>),
    }));
    sendJson(res, 200, {
      model:
        behaviour.misbehave === "bad-model"
          ? "not a model id"
          : (behaviour.model ??
            DEFAULT_MODELS[capability as EnrichCapability] ??
            "fake@1"),
      results:
        behaviour.misbehave === "wrong-count" ? results.slice(1) : results,
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    config: {
      endpoint: new URL(`http://127.0.0.1:${port}`),
      ...(options.token ? { token: options.token } : {}),
    },
    calls,
    probes: () => probes,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
