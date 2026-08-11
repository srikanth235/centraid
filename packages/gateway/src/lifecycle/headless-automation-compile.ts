import { randomUUID } from "node:crypto";
// governance: allow-repo-hygiene file-size-limit (#567) the headless compile boundary is one lock/hydration/failover/ledger transaction; splitting settlement from dispatch would obscure its exactly-once guarantees
import path from "node:path";

import { resolveItemCost, TURN_POSTURES } from "@centraid/app-engine";
import type {
  ConversationRunner,
  ProviderConsentSource,
  ProviderEgressConsentController,
  HarnessKind,
  TurnStreamEvent,
} from "@centraid/app-engine";
import { validateManifest } from "@centraid/automation";
import type { Manifest, ManifestVaultScope } from "@centraid/automation";

import { journalConversationStore } from "../journal-stores.js";
import { AUTOMATION_ANCHOR_ENTITY } from "./automation-anchor-scopes.js";
import type { ResolvedAutomationAnchor } from "./automation-anchor-scopes.js";

export interface HeadlessCompileOptions {
  runner: ConversationRunner;
  journalDbFile: string;
  runnerSessionDir: string;
  dataDir: string;
  appId: string;
  /** A fresh, one-shot worktree session for this compile. */
  draftSessionId: string;
  automationRef: string;
  automationName: string;
  instructions: string;
  /** Validated manifest harness override. */
  harnessKind?: HarnessKind;
  /** Explicit manifest/prefs-resolved model for this compile. */
  model?: string;
  /** Semantic ACP configuration pins for this compile. */
  configPins?: Readonly<Record<string, string>>;
  /** Durable egress grant controller; compile attempts are unattended. */
  providerEgressConsent?: ProviderEgressConsentController;
  /**
   * How the user authored this attempt's harness: `direct` = their automations
   * primary, `ladder` = current failover membership. Omit when the harness came
   * from a manifest pin the user never authored — the compile is then denied
   * unless a real grant already exists (#567 D13).
   */
  consentSource?: ProviderConsentSource;
  /** Resolve historical upload hashes into this automation app's blob CAS. */
  hydrationAttachmentPath?: (hash: string) => string;
  /** Durable reader-facing notice when this attempt follows a failed rung. */
  failoverNotice?: string;
  /** Anchor tokens resolved against the addressed vault before the model runs. */
  anchors?: readonly ResolvedAutomationAnchor[];
  /** Fail-closed anchor resolution error, recorded as this compile turn. */
  preflightError?: string;
  onSuccess: () => Promise<void>;
  onFailure?: (
    error: string,
    failureClass?: Extract<TurnStreamEvent, { type: "error" }>["failureClass"]
  ) => Promise<void> | void;
  runId?: string;
}

export interface RecordFailedAutomationCompileOptions {
  journalDbFile: string;
  automationRef: string;
  appId: string;
  automationName: string;
  runId: string;
  error: string;
  harnessKind?: HarnessKind;
  /** Turn note. Defaults to the "reserved id never started" wording. */
  note?: string;
  /** Turn summary shown in the thread. Defaults to `Compile failed`. */
  summary?: string;
}

type UsageEvent = Extract<TurnStreamEvent, { type: "usage" }>;

function compileUsageFields(usage: UsageEvent | undefined): {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costSource?: "agent" | "estimated";
  effort?: string;
} {
  if (!usage) return {};
  const cost =
    usage.costUsd === undefined
      ? resolveItemCost({
          model: usage.model,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
          },
        })
      : {
          costUsd: usage.costUsd,
          costSource: usage.costSource ?? ("agent" as const),
        };
  return {
    ...(usage.model === undefined ? {} : { model: usage.model }),
    ...(usage.provider === undefined ? {} : { provider: usage.provider }),
    ...(usage.inputTokens === undefined
      ? {}
      : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined
      ? {}
      : { outputTokens: usage.outputTokens }),
    ...(usage.cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(cost.costUsd === undefined ? {} : { costUsd: cost.costUsd }),
    ...(cost.costSource === undefined ? {} : { costSource: cost.costSource }),
    ...(usage.effort === undefined ? {} : { effort: usage.effort }),
  };
}

/** Settle a compile id reserved before a prerequisite rewrite could start. */
export function recordFailedAutomationCompile(
  opts: RecordFailedAutomationCompileOptions
): void {
  const store = journalConversationStore(opts.journalDbFile);
  const existing = store.getTurn(opts.runId);
  if (existing?.endedAt !== undefined) return;
  if (!existing) {
    const conversationId = store.ensureAutomationConversation(
      opts.automationRef,
      opts.appId,
      opts.automationName,
      opts.harnessKind
    );
    store.insertTurn({
      turnId: opts.runId,
      conversationId,
      triggerKind: "compile",
      triggerOrigin: "manual",
      note: opts.note ?? "Compile blocked before start",
      startedAt: Date.now(),
    });
  }
  store.finishTurn({
    turnId: opts.runId,
    endedAt: Date.now(),
    ok: false,
    error: opts.error,
    summary: opts.summary ?? "Compile failed",
  });
}

export const HEADLESS_COMPILE_WORK_ORDER = (
  instructions: string,
  anchors: readonly ResolvedAutomationAnchor[] = []
): string => {
  const anchorTokens = new Set(anchors.map((anchor) => anchor.token));
  const entities = Array.from(
    instructions.matchAll(/@\[(?<type>[^/\]]+)\/(?<id>[^\]]+)\]/gu)
  ).filter(
    (match) =>
      !anchorTokens.has(match[0]) && match[1] !== AUTOMATION_ANCHOR_ENTITY
  );
  return [
    "Compile this automation headlessly. This is a work order, not a conversation.",
    "Update automation.json only when derived requirements or vault scopes need to change.",
    "Write a complete deterministic handler.js that implements the instructions.",
    'When the instructions describe reacting to vault-data changes, declare a data trigger; when they describe a data-state window ("due in N days"), declare a condition trigger — with vault read scopes covering every watched entity — instead of approximating either with a cron poll.',
    'When the instructions name a specific harness and/or model for a step (e.g. "use opencode deepseek-ocr for the OCR step", "summarize with the default harness"), compile that into `ctx.delegate({ harness, model, prompt, ... })` on exactly that call — do not rewrite manifest.requires.harness or requires.model for a per-step preference, and never invent a harness/model the instructions did not name. Omit harness/model entirely on a call the instructions leave unspecified — it rides the automation\'s own fixed harness/model. A step naming a harness that fails must surface that failure, never silently retry a different harness inside the handler.',
    "Leave existing cron/webhook triggers alone unless the instructions changed them.",
    "Do not change the enabled field; the gateway owns enable/disable lifecycle after validation.",
    "Use generated.by = 'centraid-compiler'. Do not ask questions. Stop after the files are ready.",
    "",
    "Instructions:",
    instructions,
    ...(anchors.length > 0
      ? [
          "",
          "Trusted anchor resolutions (use only these resolved source rows and fields; never broaden their declared scopes):",
          ...anchors.map(
            (anchor) =>
              `- ${anchor.token} => ${anchor.sourceType}/${anchor.sourceId} field ${anchor.sourceField}, exact span ${JSON.stringify(anchor.selector.exact)}, linked to ${anchor.targetType}/${anchor.targetId}; read only through the manifest rowFilter + fieldMask supplied by the gateway`
          ),
        ]
      : []),
    ...(entities.length > 0
      ? [
          "",
          "Stable entity tokens (compile each into a consent-checked runtime resolution before use):",
          ...entities.map((match) =>
            match[2] === "*"
              ? `- ${match[0]} => the ${match[1]} entity kind (read scope granted; query it via ctx.vault, do not resolve a single row)`
              : `- ${match[0]} => await ctx.vault.resolve({ refs: [{ type: '${match[1]}', id: '${match[2]}' }], purpose: 'dpv:ServiceProvision' })`
          ),
        ]
      : []),
  ].join("\n");
};

/** Apply gateway-owned lifecycle/provenance after the agent has written its draft. */
export function finalizeCompiledManifest(
  manifest: Manifest,
  options: {
    enabledBeforeCompile: boolean;
    enableOnSuccess: boolean;
    compiledAt?: Date;
    anchoredScopes?: readonly ManifestVaultScope[];
  }
): Manifest {
  const taggedScopes: ManifestVaultScope[] = Array.from(
    manifest.prompt.matchAll(
      /@\[(?<schema>[^/.\]]+)\.(?<table>[^/\]]+)\/[^\]]+\]/gu
    ),
    (match) => ({ schema: match[1]!, table: match[2]!, verbs: "read" as const })
  ).filter(
    (scope) => !(scope.schema === "core" && scope.table === "link_anchor")
  );
  const anchoredScopes = [...(options.anchoredScopes ?? [])];
  const anchoredTables = new Set(
    anchoredScopes.map((scope) => `${scope.schema}.${scope.table}`)
  );
  const scopes: ManifestVaultScope[] = [...anchoredScopes];
  for (const existing of manifest.vault?.scopes ?? []) {
    // A model-authored broad read on an anchored table must not coexist with
    // the gateway's exact row/field attenuation. Preserve an act capability
    // from read+act, but strip the broad read half.
    if (
      existing.table &&
      anchoredTables.has(`${existing.schema}.${existing.table}`) &&
      (existing.verbs === "read" || existing.verbs === "read+act") &&
      !existing.rowFilter &&
      !existing.fieldMask
    ) {
      if (existing.verbs === "read+act")
        scopes.push({ ...existing, verbs: "act" });
      continue;
    }
    scopes.push(existing);
  }
  for (const scope of taggedScopes) {
    if (scope.table && anchoredTables.has(`${scope.schema}.${scope.table}`))
      continue;
    if (
      !scopes.some(
        (existing) =>
          existing.schema === scope.schema &&
          existing.table === scope.table &&
          existing.verbs === scope.verbs &&
          JSON.stringify(existing.rowFilter ?? null) ===
            JSON.stringify(scope.rowFilter ?? null) &&
          JSON.stringify(existing.fieldMask ?? null) ===
            JSON.stringify(scope.fieldMask ?? null)
      )
    ) {
      scopes.push(scope);
    }
  }
  return validateManifest({
    ...manifest,
    enabled: options.enableOnSuccess ? true : options.enabledBeforeCompile,
    ...(scopes.length > 0
      ? {
          vault: {
            purpose: manifest.vault?.purpose ?? "dpv:ServiceProvision",
            ...(manifest.vault?.why ? { why: manifest.vault.why } : {}),
            scopes,
          },
        }
      : {}),
    generated: {
      by: "centraid-compiler",
      at: (options.compiledAt ?? new Date()).toISOString(),
    },
  });
}

/** Drive the existing unified builder runner without exposing a builder conversation UI. */
export async function runHeadlessAutomationCompile(
  opts: HeadlessCompileOptions
): Promise<void> {
  const store = journalConversationStore(opts.journalDbFile);
  const runId =
    opts.runId ?? `${opts.automationRef}:compile:${randomUUID().slice(0, 8)}`;
  const conversationId = store.ensureAutomationConversation(
    opts.automationRef,
    opts.appId,
    opts.automationName,
    opts.harnessKind
  );
  const lockToken = randomUUID();
  if (!store.acquireTurnLock(conversationId, lockToken)) {
    throw new Error(
      `automation conversation "${conversationId}" already has a running turn`
    );
  }
  const lockLeaseHeartbeat = setInterval(
    () => store.refreshTurnLock(conversationId, lockToken),
    60_000
  );
  lockLeaseHeartbeat.unref?.();
  try {
    const conversation = store.getConversation(conversationId);
    if (!conversation)
      throw new Error(
        `automation conversation "${conversationId}" was not created`
      );
    // Binding, resume handle, watermark and the budgeted fold are one owner's
    // job, keyed per harness — the compile asks it per rung through the runner
    // instead of planning once against the harness it happened to name.
    const harnessSessions = store.harnessSessions(conversationId, {
      hydration: TURN_POSTURES.compile.hydration,
      ...(opts.hydrationAttachmentPath
        ? { attachmentPath: opts.hydrationAttachmentPath }
        : {}),
    });
    const startedAt = Date.now();
    const message = HEADLESS_COMPILE_WORK_ORDER(
      opts.instructions,
      opts.anchors
    );
    store.insertTurn({
      turnId: runId,
      conversationId,
      triggerKind: "compile",
      note:
        opts.failoverNotice ??
        (opts.harnessKind
          ? `Compiling plan with ${opts.harnessKind}`
          : "Compiling plan"),
      startedAt,
    });
    store.insertMessageIn({
      turnId: runId,
      role: "user",
      text: message,
      startedAt,
    });
    if (opts.failoverNotice) {
      store.insertItem({
        itemId: randomUUID(),
        turnId: runId,
        ordinal: 1,
        kind: "step",
        // Machine-keyed like every other notice item (`notice:<level>:<code>`)
        // so readers key off the code, not a human string.
        name: "notice:warn:failover",
        outputJson: JSON.stringify({ text: opts.failoverNotice }),
        ok: true,
        startedAt,
        endedAt: startedAt,
        durationMs: 0,
      });
    }

    let finalText = "";
    let errorMessage: string | undefined;
    let failureClass: Extract<
      TurnStreamEvent,
      { type: "error" }
    >["failureClass"];
    let rawJson: string | undefined;
    let stopReason: string | undefined;
    let usage: UsageEvent | undefined;
    const onEvent = (event: TurnStreamEvent): void => {
      if (event.type === "final") {
        finalText = event.text;
        rawJson = event.rawJson;
        stopReason = event.stopReason;
      }
      if (event.type === "error") {
        errorMessage = event.message;
        failureClass = event.failureClass;
        rawJson = event.rawJson;
        stopReason = event.stopReason;
      }
      if (event.type === "consent.required") {
        // Headless compiles have no owner present to answer an egress prompt.
        // Treat the unsent turn as blocked instead of publishing the untouched
        // scaffold and falsely recording "Plan ready".
        errorMessage = event.message;
        stopReason = "consent_required";
      }
      if (event.type === "aborted") {
        errorMessage = "Compile aborted";
        stopReason = "cancelled";
      }
      if (event.type === "usage") usage = event;
    };

    try {
      if (opts.preflightError) throw new Error(opts.preflightError);
      // A compile is unattended: no owner is present to answer an egress
      // prompt, so consent must already exist or be derivable from what the
      // user authored in Settings. Deriving must never resurrect a revocation
      // or invent a lane for a provider absent from the ladder (#567 D5/D13).
      const consent = opts.providerEgressConsent;
      if (
        opts.harnessKind &&
        consent &&
        !consent.has(conversationId, opts.harnessKind, "automations")
      ) {
        const derived =
          opts.consentSource === undefined
            ? false
            : (consent.recordDerived?.(
                conversationId,
                opts.harnessKind,
                opts.consentSource,
                "automations"
              ) ?? false);
        if (!derived) {
          throw new Error(
            `Unattended compile cannot send this automation to ${opts.harnessKind}: ` +
              `no consent is recorded for it. Add ${opts.harnessKind} to the automations ` +
              `agent or its failover ladder in Settings, or approve the provider in a ` +
              `conversation with this automation.`
          );
        }
      }
      // The injected unified gateway runner is intrinsically headless: its
      // Claude adapter pins bypassPermissions and its Codex adapter pins
      // approvalPolicy=never + workspace-write. There is deliberately no
      // per-turn escape hatch on ConversationRunner that can weaken this.
      await opts.runner.run({
        appId: opts.appId,
        draftSessionId: opts.draftSessionId,
        dataDir: opts.dataDir,
        conversationId,
        sessionFile: path.join(
          opts.runnerSessionDir,
          `${encodeURIComponent(conversationId)}.jsonl`
        ),
        message,
        register: "build",
        extraSystemPrompt: "",
        ...(opts.harnessKind ? { harnessKind: opts.harnessKind } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.configPins ? { configPins: opts.configPins } : {}),
        ...(conversation.harnessKind
          ? { activeHarnessKind: conversation.harnessKind }
          : {}),
        harnessSessions,
        abortSignal: new AbortController().signal,
        onEvent,
      });
      if (errorMessage) throw new Error(errorMessage);
      await opts.onSuccess();
      const endedAt = Date.now();
      store.runInTransaction(() => {
        if (finalText || usage || rawJson || stopReason) {
          store.insertItem({
            itemId: randomUUID(),
            turnId: runId,
            ordinal: opts.failoverNotice ? 2 : 1,
            kind: "step",
            outputJson: JSON.stringify({
              text: finalText || "Plan ready",
              ...(stopReason === undefined ? {} : { stopReason }),
            }),
            ...(rawJson === undefined ? {} : { rawJson }),
            ok: true,
            startedAt,
            endedAt,
            durationMs: endedAt - startedAt,
            ...compileUsageFields(usage),
          });
        }
        store.finishTurn({
          turnId: runId,
          endedAt,
          ok: true,
          summary: "Plan ready",
          ...(stopReason === undefined
            ? {}
            : {
                outputJson: JSON.stringify({
                  stopReason,
                  text: finalText || "Plan ready",
                }),
              }),
        });
        if (harnessSessions.hydrationTokens > 0) {
          store.setTurnHydrationTokens(runId, harnessSessions.hydrationTokens);
        }
        store.noteTurn(conversationId, "", harnessSessions.bindings);
      });
    } catch (error) {
      const messageLocal =
        error instanceof Error ? error.message : String(error);
      const endedAt = Date.now();
      store.runInTransaction(() => {
        store.insertItem({
          itemId: randomUUID(),
          turnId: runId,
          ordinal: opts.failoverNotice ? 2 : 1,
          kind: "step",
          outputJson: JSON.stringify({
            error: messageLocal,
            ...(finalText ? { text: finalText } : {}),
            ...(stopReason === undefined ? {} : { stopReason }),
          }),
          ...(rawJson === undefined ? {} : { rawJson }),
          ok: false,
          error: messageLocal,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          ...compileUsageFields(usage),
        });
        store.finishTurn({
          turnId: runId,
          endedAt,
          ok: false,
          error: messageLocal,
          summary: "Compile failed",
          ...(stopReason === undefined
            ? {}
            : {
                outputJson: JSON.stringify({ stopReason, error: messageLocal }),
              }),
        });
        if (harnessSessions.hydrationTokens > 0) {
          store.setTurnHydrationTokens(runId, harnessSessions.hydrationTokens);
        }
        store.noteFailedTurn(conversationId, "", harnessSessions.bindings);
      });
      if (failureClass === undefined) {
        await opts.onFailure?.(messageLocal);
      } else {
        await opts.onFailure?.(messageLocal, failureClass);
      }
    }
  } finally {
    clearInterval(lockLeaseHeartbeat);
    store.releaseTurnLock(conversationId, lockToken);
  }
}
