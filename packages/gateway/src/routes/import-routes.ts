// File-drop import routes (issue #290 phase 2) — the owner's staged-import
// surface over the vault's staging spine. First contact with real data is
// always a DRAFT: stage returns a disposition summary, the owner reviews,
// then publishes or discards. Everything runs with the owner-device
// credential; receipts and provenance are the vault gateway's.
//
//   POST   /centraid/_vault/imports                    stage a file
//          body {filename, text? | base64?, accountName?, currency?}
//   GET    /centraid/_vault/imports                    batches, newest first
//   GET    /centraid/_vault/imports/<batchId>          the batch's rows
//   POST   /centraid/_vault/imports/<batchId>/publish  apply the draft
//   POST   /centraid/_vault/imports/<batchId>/discard  drop the draft
//   GET    /centraid/_vault/imports/connections        connection health
//   POST   /centraid/_vault/imports/connections/<id>/status  {status: paused|active}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { readJson, sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault/imports';
/** Imports carry whole mailboxes / Takeout zips — cap well above chat bodies. */
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

export function makeImportRouteHandler(vaults: Pick<VaultRegistry, 'current'>): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);
    const method = req.method ?? 'GET';
    const plane = vaults.current();
    const owner = plane.ownerCredential;
    const purpose = 'dpv:ServiceProvision';

    try {
      if (method === 'POST' && segments.length === 0) {
        const body = await readJson(req, MAX_IMPORT_BYTES);
        const filename = String(body.filename ?? '');
        if (!filename) return sendJson(res, 400, { error: 'filename is required' });
        const data =
          typeof body.base64 === 'string'
            ? Buffer.from(body.base64, 'base64')
            : String(body.text ?? '');
        const result = plane.gateway.stageImportFile(owner, {
          filename,
          data,
          ...(typeof body.accountName === 'string' ? { accountName: body.accountName } : {}),
          ...(typeof body.currency === 'string' ? { currency: body.currency } : {}),
        });
        return sendJson(res, 200, result);
      }

      if (method === 'GET' && segments.length === 0) {
        const batches = plane.gateway.read(owner, {
          entity: 'sync.import_batch',
          orderBy: { column: 'batch_id', dir: 'desc' },
          limit: 50,
          purpose,
        }).rows;
        const connections = new Map(
          plane.gateway
            .read(owner, { entity: 'sync.connection', purpose, limit: 500 })
            .rows.map((c) => [c.connection_id, c]),
        );
        return sendJson(res, 200, {
          batches: batches.map((b) => {
            const connection = connections.get(b.connection_id);
            return {
              batchId: b.batch_id,
              status: b.status,
              createdAt: b.created_at,
              resolvedAt: b.resolved_at,
              summary: JSON.parse(String(b.summary_json ?? '{}')) as Record<string, unknown>,
              kind: connection?.kind ?? null,
              label: connection?.label ?? null,
            };
          }),
        });
      }

      if (method === 'GET' && segments.length === 1 && segments[0] === 'connections') {
        // The health surface (issue #290 phase 4): every connection with its
        // latest run — status is READABLE state, sync never dies silently.
        const connections = plane.gateway.read(owner, {
          entity: 'sync.connection',
          orderBy: { column: 'connection_id', dir: 'desc' },
          limit: 200,
          purpose,
        }).rows;
        const runs = plane.gateway.read(owner, {
          entity: 'sync.connection_run',
          orderBy: { column: 'run_id', dir: 'desc' },
          limit: 500,
          purpose,
        }).rows;
        const latestRun = new Map<unknown, Record<string, unknown>>();
        for (const run of runs) {
          if (!latestRun.has(run.connection_id)) latestRun.set(run.connection_id, run);
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
        method === 'POST' &&
        segments.length === 3 &&
        segments[0] === 'connections' &&
        segments[2] === 'status'
      ) {
        const body = await readJson(req);
        const outcome = plane.gateway.invoke(owner, {
          command: 'sync.set_connection_status',
          input: { connection_id: segments[1], status: String(body.status ?? '') },
          purpose,
        });
        return sendJson(res, outcome.status === 'executed' ? 200 : 400, outcome);
      }

      if (method === 'GET' && segments.length === 1) {
        const rows = plane.gateway.read(owner, {
          entity: 'sync.import_row',
          where: [{ column: 'batch_id', op: 'eq', value: segments[0] }],
          orderBy: { column: 'seq' },
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
          })),
        });
      }

      if (method === 'POST' && segments.length === 2 && segments[1] === 'publish') {
        return sendJson(res, 200, plane.gateway.publishImport(owner, segments[0] ?? ''));
      }
      if (method === 'POST' && segments.length === 2 && segments[1] === 'discard') {
        return sendJson(res, 200, plane.gateway.discardImport(owner, segments[0] ?? ''));
      }
    } catch (err) {
      return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return sendJson(res, 405, { error: `unsupported ${method} on ${url.pathname}` });
  };
}
