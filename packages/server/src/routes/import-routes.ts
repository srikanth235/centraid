import type { IncomingMessage, ServerResponse } from "node:http";

import {
  importPortableVault,
  isMediaPath,
  writeZipEntries,
} from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { readJson, sendJson } from "./route-helpers.js";

const PREFIX = "/centraid/_vault/imports";
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

const TARGET_FIELDS: Readonly<Record<string, string>> = {
  "core.event": "Calendar event",
  "core.party": "Person + contact channels",
  "core.transaction": "Finance transaction",
  "knowledge.note": "Note + notebook path",
  "locker.item": "Locker login",
  "media.asset": "Photo or video + capture time, place, album",
  "social.message": "Message + attachments",
};

function isBinaryUpload(filename: string): boolean {
  return filename.toLowerCase().endsWith(".zip") || isMediaPath(filename);
}

function decodeImportBody(
  body: Record<string, unknown>,
  filename: string
): Buffer | string {
  const hasText = typeof body.text === "string";
  const hasBase64 = typeof body.base64 === "string";
  if (hasText === hasBase64)
    throw new Error("provide exactly one of text or base64");
  if (hasText) {
    const text = body.text as string;
    if (text.includes("\0")) throw new Error(`NUL byte in ${filename}`);
    return text;
  }
  const compact = (body.base64 as string).replace(/\s+/gu, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
  ) {
    throw new Error("base64 is malformed");
  }
  const data = Buffer.from(compact, "base64");
  if (!isBinaryUpload(filename)) {
    if (
      (data[0] === 0xff && data[1] === 0xfe) ||
      (data[0] === 0xfe && data[1] === 0xff)
    ) {
      throw new Error(`unsupported UTF-16 encoding in ${filename}; use UTF-8`);
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      if (text.includes("\0")) throw new Error(`NUL byte in ${filename}`);
      return text.startsWith("\uFEFF") ? text.slice(1) : text;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("NUL byte"))
        throw error;
      throw new Error(`invalid UTF-8 in ${filename}`, { cause: error });
    }
  }
  return data;
}

function markdownDirectory(body: Record<string, unknown>): {
  filename: string;
  data: Buffer;
} | null {
  if (!Array.isArray(body.files)) return null;
  const directoryName = String(body.directoryName ?? "Markdown notes")
    .replaceAll(/[^\p{L}\p{N} ._-]/gu, "-")
    .slice(0, 120);
  const files = body.files.map((value) => {
    if (!value || typeof value !== "object")
      throw new Error("directory files must be objects");
    const item = value as Record<string, unknown>;
    if (typeof item.path !== "string" || typeof item.text !== "string")
      throw new Error("directory files require path and text");
    if (!/\.md(?:own)?$/iu.test(item.path))
      throw new Error(`directory contains unsupported file: ${item.path}`);
    return { name: item.path, data: Buffer.from(item.text, "utf8") };
  });
  if (files.length === 0) throw new Error("Markdown directory is empty");
  return {
    filename: `${directoryName || "Markdown notes"}.zip`,
    data: writeZipEntries(files),
  };
}

export function makeImportRouteHandler(
  vaults: Pick<VaultRegistry, "current">
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`))
      return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//u, "");
    const segments = rest === "" ? [] : rest.split("/").map(decodeURIComponent);
    const method = req.method ?? "GET";
    const plane = vaults.current();
    const owner = plane.ownerCredential;
    const purpose = "dpv:ServiceProvision";

    try {
      if (method === "POST" && segments.length === 0) {
        const body = await readJson(req, MAX_IMPORT_BYTES);
        const directory = markdownDirectory(body);
        const filename = directory?.filename ?? String(body.filename ?? "");
        if (!filename)
          return sendJson(res, 400, { error: "filename is required" });
        const data = directory?.data ?? decodeImportBody(body, filename);
        if (filename === "centraid-portable-v1.zip") {
          if (!Buffer.isBuffer(data))
            return sendJson(res, 400, {
              error: "portable import requires base64",
            });
          if (body.replaceFreshVault !== true)
            return sendJson(res, 400, {
              error: "portable import requires replaceFreshVault: true",
            });
          const result = importPortableVault(plane.db, data, {
            replaceBootstrap: true,
            ...(typeof body.passphrase === "string"
              ? { passphrase: body.passphrase }
              : {}),
          });
          return sendJson(res, 200, { portable: true, ...result });
        }
        const result = plane.gateway.stageImportFile(owner, {
          filename,
          data,
          ...(typeof body.accountName === "string"
            ? { accountName: body.accountName }
            : {}),
          ...(typeof body.currency === "string"
            ? { currency: body.currency }
            : {}),
          ...(typeof body.captureGroupId === "string"
            ? { captureGroupId: body.captureGroupId }
            : {}),
        });
        return sendJson(res, 200, result);
      }

      if (
        (method === "GET" || method === "POST") &&
        segments.length === 1 &&
        segments[0] === "export"
      ) {
        const passphrase =
          method === "POST"
            ? String((await readJson(req)).passphrase ?? "")
            : "";
        const exported = await plane.gateway.exportPortableVault(
          owner,
          passphrase.length > 0 ? { passphrase } : {}
        );
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${exported.filename}"`
        );
        res.setHeader("Content-Length", String(exported.bytes.length));
        res.setHeader("X-Centraid-Export-Id", exported.exportId);
        res.setHeader("X-Centraid-Receipt-Id", exported.receiptId);
        res.setHeader("X-Centraid-Export-Sealed", exported.manifest.sealed);
        res.end(exported.bytes);
        return true;
      }

      if (method === "GET" && segments.length === 0) {
        const batches = plane.gateway.read(owner, {
          entity: "sync.import_batch",
          orderBy: { column: "batch_id", dir: "desc" },
          limit: 50,
          purpose,
        }).rows;
        const connections = new Map(
          plane.gateway
            .read(owner, { entity: "sync.connection", purpose, limit: 500 })
            .rows.map((c) => [c.connection_id, c])
        );
        return sendJson(res, 200, {
          batches: batches.map((b) => {
            const connection = connections.get(b.connection_id);
            return {
              batchId: b.batch_id,
              status: b.status,
              createdAt: b.created_at,
              resolvedAt: b.resolved_at,
              summary: JSON.parse(String(b.summary_json ?? "{}")) as Record<
                string,
                unknown
              >,
              kind: connection?.kind ?? null,
              label: connection?.label ?? null,
            };
          }),
        });
      }

      if (
        method === "GET" &&
        segments.length === 1 &&
        segments[0] === "connections"
      ) {
        const connections = plane.gateway.read(owner, {
          entity: "sync.connection",
          orderBy: { column: "connection_id", dir: "desc" },
          limit: 200,
          purpose,
        }).rows;
        const runs = plane.gateway.read(owner, {
          entity: "sync.connection_run",
          orderBy: { column: "run_id", dir: "desc" },
          limit: 500,
          purpose,
        }).rows;
        const latestRun = new Map<unknown, Record<string, unknown>>();
        for (const run of runs) {
          if (!latestRun.has(run.connection_id))
            latestRun.set(run.connection_id, run);
        }
        return sendJson(res, 200, {
          connections: connections.map((c) => {
            const run = latestRun.get(c.connection_id);
            return {
              connectionId: c.connection_id,
              kind: c.kind,
              label: c.label,
              principal: c.principal,
              status: c.status,
              lastRunAt: c.last_run_at,
              lastRun: run
                ? {
                    status: run.status,
                    startedAt: run.started_at,
                    staged: run.staged,
                    published: run.published,
                    error: run.error,
                  }
                : null,
            };
          }),
        });
      }

      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "connections" &&
        segments[2] === "status"
      ) {
        const body = await readJson(req);
        const outcome = await plane.invoke(owner, {
          command: "sync.set_connection_status",
          input: {
            connection_id: segments[1],
            status: String(body.status ?? ""),
          },
          purpose,
        });
        return sendJson(
          res,
          outcome.status === "executed" ? 200 : 400,
          outcome
        );
      }

      if (method === "GET" && segments.length === 1) {
        const rows = plane.gateway.read(owner, {
          entity: "sync.import_row",
          where: [{ column: "batch_id", op: "eq", value: segments[0] }],
          orderBy: { column: "seq" },
          limit: 10_000,
          purpose,
        }).rows;
        return sendJson(res, 200, {
          rows: rows.map((r) => ({
            seq: r.seq,
            entityType: r.entity_type,
            externalId: r.external_id,
            disposition: r.disposition,
            note: r.note,
            publishedEntityId: r.published_entity_id,
            mapping: `${Object.keys(
              JSON.parse(String(r.payload_json ?? "{}")) as Record<
                string,
                unknown
              >
            ).join(
              ", "
            )} → ${TARGET_FIELDS[String(r.entity_type)] ?? String(r.entity_type)}`,
          })),
        });
      }

      if (
        method === "POST" &&
        segments.length === 2 &&
        segments[1] === "publish"
      ) {
        return sendJson(
          res,
          200,
          plane.gateway.publishImport(owner, segments[0] ?? "")
        );
      }
      if (
        method === "POST" &&
        segments.length === 2 &&
        segments[1] === "discard"
      ) {
        return sendJson(
          res,
          200,
          plane.gateway.discardImport(owner, segments[0] ?? "")
        );
      }
    } catch (error) {
      return sendJson(res, 400, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return sendJson(res, 405, {
      error: `unsupported ${method} on ${url.pathname}`,
    });
  };
}
