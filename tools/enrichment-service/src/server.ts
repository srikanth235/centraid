import http from "node:http";
import { pathToFileURL } from "node:url";

import { CAPABILITIES, findCapability } from "./capabilities/registry.js";
import { loadConfig } from "./config.js";
import type { ServiceConfig } from "./config.js";
import type {
  CapabilitiesResponse,
  EnrichItemsRequest,
  EnrichResponse,
  ItemResult,
} from "./types.js";

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function isAuthorized(
  req: http.IncomingMessage,
  config: ServiceConfig
): boolean {
  if (!config.authToken) {
    return true;
  }
  const header = req.headers.authorization;
  return header === `Bearer ${config.authToken}`;
}

/**
 * Reads the request body, enforcing `maxBodyBytes` without ever buffering
 * past the cap. Deliberately keeps draining (and discarding) the stream
 * instead of destroying the socket the moment the cap trips: a client that
 * has already started writing a large body (as `fetch` does — it doesn't
 * wait for the server to read before sending) gets a connection reset
 * instead of the intended 413 response if the server tears down the
 * connection mid-upload, since there's nothing left to write the response
 * onto. Rejecting only after `end` lets the normal response path send 413.
 */
function readBody(
  req: http.IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new BodyTooLargeError());
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on("error", reject);
  });
}

class BodyTooLargeError extends Error {
  constructor() {
    super("request body exceeds the configured size cap");
    this.name = "BodyTooLargeError";
  }
}

async function buildCapabilitiesResponse(
  config: ServiceConfig
): Promise<CapabilitiesResponse> {
  const entries = await Promise.all(
    CAPABILITIES.map(async (capability) => {
      const available = await capability.isAvailable(config);
      return available
        ? ([capability.name, { model: capability.modelId() }] as const)
        : undefined;
    })
  );
  const capabilities: CapabilitiesResponse["capabilities"] = {};
  for (const entry of entries) {
    if (entry) {
      const [name, info] = entry;
      capabilities[name] = info;
    }
  }
  return { capabilities };
}

async function handleEnrich(
  capabilityName: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ServiceConfig
): Promise<void> {
  // Body size/shape is validated before capability lookup — an oversized
  // or malformed request is rejected the same way regardless of which
  // route it hit, and doing this first means the 413 cap is enforceable
  // even for a request aimed at an unadvertised capability.
  let body: Buffer;
  try {
    body = await readBody(req, config.maxBodyBytes);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "payload too large" });
      return;
    }
    sendJson(res, 400, { error: "failed to read request body" });
    return;
  }

  let parsed: EnrichItemsRequest;
  try {
    parsed = JSON.parse(body.toString("utf8")) as EnrichItemsRequest;
  } catch {
    sendJson(res, 400, { error: "request body is not valid JSON" });
    return;
  }

  if (!Array.isArray(parsed.items)) {
    sendJson(res, 400, { error: "request body must have an `items` array" });
    return;
  }

  const capability = findCapability(capabilityName);
  const available = capability ? await capability.isAvailable(config) : false;
  if (!capability || !available) {
    sendJson(res, 404, { error: "unavailable" });
    return;
  }

  // Every item is handled independently inside capability.handle (each
  // capabilities/*.ts function catches its own errors and returns an
  // {id, error} result) — a single malformed or failing item never fails
  // the whole batch, and single-item requests get no batch-accumulation
  // delay since there is no batching step here at all.
  const results: Array<ItemResult<unknown>> = await capability.handle(
    parsed.items,
    config
  );
  const response: EnrichResponse<unknown> = {
    model: capability.modelId(),
    results,
  };
  sendJson(res, 200, response);
}

export function createServer(
  config: ServiceConfig = loadConfig()
): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        if (!isAuthorized(req, config)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/capabilities") {
          sendJson(res, 200, await buildCapabilitiesResponse(config));
          return;
        }

        const enrichMatch = /^\/enrich\/(?<capability>[^/]+)$/u.exec(
          url.pathname
        );
        if (req.method === "POST" && enrichMatch) {
          await handleEnrich(
            enrichMatch.groups?.capability as string,
            req,
            res,
            config
          );
          return;
        }

        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : "internal error",
        });
      }
    })();
  });
}

export function startServer(config: ServiceConfig = loadConfig()): http.Server {
  const server = createServer(config);
  // Bind 127.0.0.1 only (issue #724 W8) — this is a local sidecar process
  // for the gateway on the same machine, never meant to accept remote
  // connections.
  server.listen(config.port, "127.0.0.1", () => {
    console.log(
      `enrichment-service listening on http://127.0.0.1:${config.port}`
    );
  });
  return server;
}

const isMainModule = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (isMainModule) {
  startServer();
}
