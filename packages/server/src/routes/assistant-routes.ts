/*
 * The vault assistant's shell-level HTTP surface (owner register — the
 * "ask your vault" chat, not any app's chat):
 *
 *   POST /centraid/_vault/assistant/_turn    ← drive one turn (SSE stream)
 *   POST /centraid/_vault/assistant/resolve  ← refs → renderable entity cards
 *
 * Conversation CRUD is NOT here: assistant threads live in the per-vault
 * conversation ledger under the reserved `_assistant` scope, so the existing
 * `/_centraid-conversations/apps/_assistant/sessions…` surface manages them
 * unchanged. The turn rides the shared SSE driver (`driveTurnOverSse`) with
 * the assistant runner: `vault_sql` as the one tool, and a preamble of
 * register + answer format + the ACTIVE vault's live schema/ontology map.
 * Everything executes with the owner-device credential, behind the gateway's
 * host-level auth like the rest of `_vault`.
 */

import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ASSISTANT_APP_ID,
  driveTurnOverSse,
  isValidConversationId,
  isHarnessKind,
  parseAdditionalDirectories,
  parseWorkspaceKind,
  parseTurnAttachmentRefs,
  resolveTurnAttachments,
  validateTurnAttachmentRefs,
} from "@centraid/server/engine";
import type {
  ConversationHistoryStore,
  ConversationRunner,
  ModelSubsystem,
  HarnessKind,
  TurnAttachmentRef,
  TurnLimiter,
} from "@centraid/server/engine";

import { assistantCwd } from "../runs/assistant-conversation-runner.js";
import { buildAssistantPrompt } from "../runs/assistant-prompt.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { parseProviderConsent, readJson, sendJson } from "./route-helpers.js";

const PREFIX = "/centraid/_vault/assistant";

export interface AssistantRouteOptions {
  vaults: VaultRegistry;
  conversationStore: ConversationHistoryStore;
  runner: ConversationRunner;
  /** Per-gateway lock map — assistant turns serialize per conversation. */
  conversationLocks: Map<string, Promise<void>>;
  /**
   * Model resolution (prefs plumbing): explicit `model` →
   * `model.<harnessKind>.<subsystem>` prefs → `model.<harnessKind>.default`
   * prefs → nothing. Optional so hermetic tests can omit it.
   */
  resolveModel?: (
    subsystem: ModelSubsystem,
    explicit?: string,
    requestedHarness?: HarnessKind
  ) => Promise<string | undefined>;
  /**
   * Fire-and-forget LLM auto-title hook (#420): a cheap-tier one-shot
   * inference fired once, after the first successful turn of a still-unnamed
   * thread. Optional so hermetic tests omit it.
   */
  generateTitle?: (args: {
    conversationId: string;
    userMessage: string;
    assistantText: string;
  }) => void;
  /**
   * Per-vault turn-concurrency gate (#420), shared with the per-app `_turn`
   * route. Optional so hermetic tests omit it (unbounded).
   */
  limiter?: () => TurnLimiter | undefined;
}

export function makeAssistantRouteHandler(
  opts: AssistantRouteOptions
): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`))
      return false;
    const rest = url.pathname.slice(PREFIX.length).replace(/^\//u, "");
    const method = (req.method ?? "GET").toUpperCase();

    try {
      if (method === "POST" && rest === "resolve") {
        const body = await readJson(req);
        const refs = Array.isArray(body.refs)
          ? body.refs.filter(
              (r): r is { type: string; id: string } =>
                !!r &&
                typeof r === "object" &&
                typeof (r as { type?: unknown }).type === "string" &&
                typeof (r as { id?: unknown }).id === "string"
            )
          : [];
        if (refs.length === 0) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "resolve body needs {refs: [{type, id}]}",
          });
        }
        return sendJson(res, 200, opts.vaults.current().resolveAsOwner(refs));
      }

      if (method === "POST" && rest === "_turn") {
        const body = await readJson(req);
        const conversationId =
          typeof body.conversationId === "string" ? body.conversationId : "";
        const message = typeof body.message === "string" ? body.message : "";
        if (!conversationId || !message) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "turn body needs {conversationId, message}",
          });
        }
        if (!isValidConversationId(conversationId)) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "Invalid conversationId.",
          });
        }
        const session = opts.conversationStore.getSessionMeta(
          ASSISTANT_APP_ID,
          conversationId
        );
        if (!session) {
          return sendJson(res, 404, {
            error: "not_found",
            message: "No such assistant thread.",
          });
        }

        const plane = opts.vaults.current();
        const extraSystemPrompt = buildAssistantPrompt(
          plane.name,
          plane.assistantContext()
        );

        // Attachments uploaded ahead of the turn (#190), mirroring the per-app
        // `_turn` route exactly: the bytes already live in the `_assistant` blob CAS.
        const attachmentRefs: TurnAttachmentRef[] = validateTurnAttachmentRefs(
          opts.conversationStore,
          ASSISTANT_APP_ID,
          parseTurnAttachmentRefs(body.attachments)
        );
        const turnAttachments = resolveTurnAttachments(
          opts.conversationStore,
          ASSISTANT_APP_ID,
          attachmentRefs
        );

        const explicitModel =
          typeof body.model === "string" ? body.model : undefined;
        const harnessKind = isHarnessKind(body.harnessKind)
          ? body.harnessKind
          : undefined;
        if (body.harnessKind !== undefined && !harnessKind) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "harnessKind must name a registered harness.",
          });
        }
        const providerConsent = parseProviderConsent(body.providerConsent);
        if (providerConsent === "invalid") {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "providerConsent must name registered harnesses.",
          });
        }
        const requestedWorkspaceKind = parseWorkspaceKind(body.workspaceKind);
        if (body.workspaceKind !== undefined && !requestedWorkspaceKind) {
          return sendJson(res, 400, {
            error: "bad_request",
            message: "workspaceKind must be one of vault-data, app, or draft.",
          });
        }
        const savedWorkspace = opts.conversationStore.getWorkspaceSelection(
          ASSISTANT_APP_ID,
          conversationId
        );
        const workspaceKind =
          requestedWorkspaceKind ?? savedWorkspace?.primaryKind ?? "vault-data";
        if (workspaceKind !== "vault-data") {
          return sendJson(res, 400, {
            error: "bad_request",
            message: `The ${workspaceKind} workspace is unavailable in the vault assistant.`,
          });
        }
        const workspaceDirectory = await fs.realpath(plane.dir);
        let additionalDirectories = savedWorkspace?.additionalDirectories ?? [];
        if (body.additionalDirectories !== undefined) {
          try {
            additionalDirectories = await parseAdditionalDirectories(
              body.additionalDirectories
            );
          } catch (error) {
            return sendJson(res, 400, {
              error: "bad_request",
              message:
                error instanceof Error
                  ? error.message
                  : "Invalid additional directory.",
            });
          }
        }
        additionalDirectories = additionalDirectories.filter(
          (directory) => directory !== workspaceDirectory
        );
        // The selection is per conversation and rarely moves, so compare
        // first rather than rewriting this row on every turn.
        const selectionUnchanged =
          savedWorkspace?.primaryKind === workspaceKind &&
          savedWorkspace.additionalDirectories.length ===
            additionalDirectories.length &&
          savedWorkspace.additionalDirectories.every(
            (directory, index) => directory === additionalDirectories[index]
          );
        if (!selectionUnchanged) {
          opts.conversationStore.setWorkspaceSelection(
            ASSISTANT_APP_ID,
            conversationId,
            workspaceKind,
            additionalDirectories
          );
        }
        const model = opts.resolveModel
          ? await opts.resolveModel("assistant", explicitModel, harnessKind)
          : explicitModel;

        const resume = opts.conversationStore.getHarnessResumeState(
          ASSISTANT_APP_ID,
          conversationId,
          harnessKind
        );
        await driveTurnOverSse({
          req,
          res,
          appId: ASSISTANT_APP_ID,
          conversationId,
          message,
          idempotencyKey:
            typeof body.idempotencyKey === "string"
              ? body.idempotencyKey
              : undefined,
          dataDir: assistantCwd(opts.vaults),
          workspaceKind,
          workspaceDirectory,
          extraSystemPrompt,
          runner: opts.runner,
          ...(opts.limiter ? { limiter: opts.limiter() } : {}),
          conversationStore: opts.conversationStore,
          conversationHarnessSessionDir:
            opts.vaults.currentWorkspace().harnessSessionDir,
          conversationLocks: opts.conversationLocks,
          banner: `assistant vault ${plane.boot.vaultId} session ${conversationId}`,
          model,
          ...(harnessKind ? { harnessKind } : {}),
          thinking:
            typeof body.thinking === "string" ? body.thinking : undefined,
          ...(providerConsent ? { providerConsent } : {}),
          ...(additionalDirectories.length ? { additionalDirectories } : {}),
          ...(typeof body.retryOf === "string" && body.retryOf
            ? { retryOf: body.retryOf }
            : {}),
          prevHarnessSessionId: resume?.sessionId,
          prevHarnessKind: resume?.kind,
          prevHarnessUsageSnapshot: resume?.usageSnapshot,
          ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
          ...(turnAttachments.length > 0 ? { turnAttachments } : {}),
          ...(opts.generateTitle ? { generateTitle: opts.generateTitle } : {}),
        });
        return true;
      }

      return sendJson(res, 404, {
        error: "not_found",
        message: "unknown assistant route",
      });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      return sendJson(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
