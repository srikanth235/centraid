/*
 * The vault assistant's shell-level HTTP surface (owner register — the
 * "ask your vault" chat, not any app's chat):
 *
 *   POST /centraid/_vault/assistant/_turn    ← drive one turn (SSE stream)
 *   POST /centraid/_vault/assistant/resolve  ← refs → renderable entity cards
 *
 * Conversation CRUD is NOT here: assistant threads live in the per-vault
 * conversation ledger under the reserved `_assistant` scope, so the
 * existing `/_centraid-conversations/apps/_assistant/sessions…` surface
 * lists/creates/renames/deletes them unchanged.
 *
 * The turn rides the shared SSE driver (`driveTurnOverSse`) with the
 * assistant runner: `vault_sql` as the one tool, and a preamble of
 * register + answer format + the ACTIVE vault's live schema/ontology map.
 * Everything executes with the owner-device credential — this surface sits
 * behind the gateway's host-level auth like the rest of `_vault`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ASSISTANT_APP_ID,
  driveTurnOverSse,
  isValidConversationId,
  type ConversationHistoryStore,
  type ConversationRunner,
} from '@centraid/app-engine';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { assistantCwd } from '../runs/assistant-conversation-runner.js';
import { buildAssistantPrompt } from '../runs/assistant-prompt.js';
import { readJson, sendJson } from './route-helpers.js';

const PREFIX = '/centraid/_vault/assistant';

export interface AssistantRouteOptions {
  vaults: VaultRegistry;
  conversationStore: ConversationHistoryStore;
  runner: ConversationRunner;
  /** Per-gateway lock map — assistant turns serialize per conversation. */
  conversationLocks: Map<string, Promise<void>>;
}

export function makeAssistantRouteHandler(opts: AssistantRouteOptions): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//, '');
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      if (method === 'POST' && rest === 'resolve') {
        const body = await readJson(req);
        const refs = Array.isArray(body.refs)
          ? body.refs.filter(
              (r): r is { type: string; id: string } =>
                !!r &&
                typeof r === 'object' &&
                typeof (r as { type?: unknown }).type === 'string' &&
                typeof (r as { id?: unknown }).id === 'string',
            )
          : [];
        if (refs.length === 0) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'resolve body needs {refs: [{type, id}]}',
          });
        }
        return sendJson(res, 200, opts.vaults.active().resolveAsOwner(refs));
      }

      if (method === 'POST' && rest === '_turn') {
        const body = await readJson(req);
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId : '';
        const message = typeof body.message === 'string' ? body.message : '';
        if (!conversationId || !message) {
          return sendJson(res, 400, {
            error: 'bad_request',
            message: 'turn body needs {conversationId, message}',
          });
        }
        if (!isValidConversationId(conversationId)) {
          return sendJson(res, 400, { error: 'bad_request', message: 'Invalid conversationId.' });
        }
        const session = opts.conversationStore.getSessionMeta(ASSISTANT_APP_ID, conversationId);
        if (!session) {
          return sendJson(res, 404, { error: 'not_found', message: 'No such assistant thread.' });
        }

        const plane = opts.vaults.active();
        const extraSystemPrompt = buildAssistantPrompt(plane.name, plane.assistantContext());

        await driveTurnOverSse({
          req,
          res,
          appId: ASSISTANT_APP_ID,
          conversationId,
          message,
          dataDir: assistantCwd(opts.vaults),
          extraSystemPrompt,
          runner: opts.runner,
          conversationStore: opts.conversationStore,
          conversationRunnerSessionDir: opts.vaults.activeWorkspace().runnerSessionDir,
          conversationLocks: opts.conversationLocks,
          banner: `assistant vault ${plane.boot.vaultId} session ${conversationId}`,
          model: typeof body.model === 'string' ? body.model : undefined,
          thinking: typeof body.thinking === 'string' ? body.thinking : undefined,
          prevAdapterSessionId: session.adapterSessionId ?? undefined,
          prevAdapterKind: session.adapterKind ?? undefined,
        });
        return true;
      }

      return sendJson(res, 404, { error: 'not_found', message: 'unknown assistant route' });
    } catch (err) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      return sendJson(res, 500, {
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
