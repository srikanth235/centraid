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

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { readJson, sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault/imports';
/** Imports carry whole mailboxes / Takeout zips — cap well above chat bodies. */
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

export function makeImportRouteHandler(vaults: Pick<VaultRegistry, 'active'>): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const segments = rest === '' ? [] : rest.split('/').map(decodeURIComponent);
    const method = req.method ?? 'GET';
    const plane = vaults.active();
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
