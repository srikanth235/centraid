// governance: allow-repo-hygiene file-size-limit (#387) one cohesive lifecycle handler family (create/update/set-enabled/rotate/delete) sharing the same session+stage+publish plumbing; splitting duplicates the shared helpers

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import nodePath from "node:path";

import { AppScaffoldError, listTemplates } from "@centraid/blueprints";
import type { ScaffoldFile } from "@centraid/blueprints";
import * as automation from "@centraid/server/automation";

import {
  defaultSessionId,
  deleteAppAndReconcile,
  prepareLifecycleSession,
  parseHistoryKeep,
  publishAndReconcile,
  stageAndMaybePublish,
  webhookUrl,
} from "../lifecycle/lifecycle-shared.js";
import type { LifecycleRouteOptions } from "../lifecycle/lifecycle-shared.js";
import { readFileMap, readJson, sendJson } from "./route-helpers.js";

function refuseSystemRecipeMutation(
  opts: LifecycleRouteOptions,
  res: ServerResponse,
  ref: { appId: string; automationId: string },
  action: string
): true | undefined {
  const canonical = `${ref.appId}/${ref.automationId}`;
  if (!opts.isSystemManagedAutomation?.(canonical)) return undefined;
  return sendJson(res, 403, {
    error: "system_recipe_read_only",
    message: `${canonical} is a release-managed recognition recipe; ${action} is unavailable. Toggle it or change its declared model/variant settings instead.`,
  });
}

export async function handleAutomationCompile(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const rawRef = url.searchParams.get("ref") ?? "";
  const ref = automation.parseRef(rawRef);
  if (!ref)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "compile needs ?ref=",
    });
  const refused = refuseSystemRecipeMutation(opts, res, ref, "compile");
  if (refused) return refused;
  if (!opts.compileAutomation) {
    return sendJson(res, 503, {
      error: "unavailable",
      message: "compile harness unavailable",
    });
  }
  const body = await readJson(req);
  const row = await automation
    .readAppOwned(opts.codeAppsDir(), ref.appId, ref.automationId)
    .catch(() => undefined);
  if (!row) {
    return sendJson(res, 404, {
      error: "not_found",
      message: `Automation "${rawRef}" does not exist.`,
    });
  }
  const compileTurnId = `${rawRef}:compile:${crypto.randomUUID().slice(0, 8)}`;
  opts.compileAutomation({
    automationRef: rawRef,
    runId: compileTurnId,
    enableOnSuccess: body.enableOnSuccess === true,
  });
  return sendJson(res, 202, { compileTurnId });
}

export async function handleAutomationRevise(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const rawRef = url.searchParams.get("ref") ?? "";
  const ref = automation.parseRef(rawRef);
  if (!ref)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "revise needs ?ref=",
    });
  const refused = refuseSystemRecipeMutation(opts, res, ref, "revision");
  if (refused) return refused;
  if (!opts.reviseAutomation) {
    return sendJson(res, 503, {
      error: "unavailable",
      message: "revision harness unavailable",
    });
  }
  const body = await readJson(req);
  const steering = typeof body.message === "string" ? body.message.trim() : "";
  if (!steering) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "revise body needs a non-empty {message}",
    });
  }
  const row = await automation
    .readAppOwned(opts.codeAppsDir(), ref.appId, ref.automationId)
    .catch(() => undefined);
  if (!row) {
    return sendJson(res, 404, {
      error: "not_found",
      message: `Automation "${rawRef}" does not exist.`,
    });
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  const revisionTurnId = `${row.ref}:revise:${suffix}`;
  const compileTurnId = `${row.ref}:compile:${suffix}`;
  opts.reviseAutomation({ row, steering, revisionTurnId, compileTurnId });
  return sendJson(res, 202, { compileTurnId });
}

export async function handleAutomationCreate(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const body = await readJson(req);
  const id = typeof body.id === "string" ? body.id : "";
  if (!id)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "create needs { id }",
    });
  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
  const sessionId = explicitSession || defaultSessionId(id);
  const ephemeralSession = !explicitSession;

  if (opts.isBundledAppId?.(id)) {
    throw new AppScaffoldError(
      "already_exists",
      `App id "${id}" is reserved by a bundled app.`
    );
  }

  const existing = await opts.store.listAppsWithMeta();
  if (existing.some((a) => a.id === id)) {
    throw new AppScaffoldError(
      "already_exists",
      `Automation app "${id}" already exists.`
    );
  }

  const ALLOWED_TRIGGER_KINDS = new Set([
    "cron",
    "webhook",
    "condition",
    "data",
    "event",
  ]);
  let webhook: { id: string; secret: string; url: string } | undefined;
  const triggerInput = Array.isArray(body.triggers)
    ? (body.triggers as Array<Record<string, unknown>>)
    : undefined;
  const badKind = triggerInput?.find(
    (t) => t.kind !== undefined && !ALLOWED_TRIGGER_KINDS.has(t.kind as string)
  );
  if (badKind) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `Unsupported trigger kind "${String(badKind.kind)}" — create accepts cron, webhook, condition, data and event triggers.`,
    });
  }
  const triggers: automation.Trigger[] | undefined = triggerInput?.map((t) => {
    if (t.kind === "webhook") {
      const wid = automation.generateWebhookId();
      const secret = automation.generateWebhookSecret();
      webhook = { id: wid, secret, url: webhookUrl(req, wid) };
      return {
        kind: "webhook",
        id: wid,
        secretHash: automation.hashWebhookSecret(secret),
      };
    }
    if (t.kind === "condition") {
      return {
        kind: "condition",
        entity: t.entity,
        ...(t.where === undefined ? {} : { where: t.where }),
        ...(t.every === undefined ? {} : { every: t.every }),
      } as automation.Trigger;
    }
    if (t.kind === "data") {
      return {
        kind: "data",
        entities: t.entities,
        ...(t.every === undefined ? {} : { every: t.every }),
      } as automation.Trigger;
    }
    if (t.kind === "event") {
      return {
        kind: "event",
        connectorKind: t.connectorKind,
        event: t.event,
        ...(t.filter === undefined ? {} : { filter: t.filter }),
        ...(t.every === undefined ? {} : { every: t.every }),
      } as automation.Trigger;
    }
    const expr = typeof t.expr === "string" ? t.expr : "0 9 * * *";
    const tz =
      typeof t.tz === "string" && t.tz.trim() ? t.tz.trim() : undefined;
    return {
      kind: "cron",
      expr,
      ...(tz === undefined ? {} : { tz }),
    };
  });
  const vaultInput =
    body.vault !== null &&
    typeof body.vault === "object" &&
    !Array.isArray(body.vault)
      ? (body.vault as automation.ManifestVault)
      : undefined;
  const connectorInput =
    body.connector !== null &&
    typeof body.connector === "object" &&
    !Array.isArray(body.connector)
      ? (body.connector as automation.ConnectorSpec)
      : undefined;
  const connectionsInput = Array.isArray(body.connections)
    ? (body.connections as automation.ConnectionBinding[])
    : undefined;

  const files = automation.scaffoldAppFiles(id, {
    ...(typeof body.name === "string" && body.name ? { name: body.name } : {}),
    ...(typeof body.description === "string" && body.description
      ? { description: body.description }
      : {}),
    ...(typeof body.prompt === "string" && body.prompt
      ? { prompt: body.prompt }
      : {}),
    ...(triggers === undefined ? {} : { triggers }),
    ...(Array.isArray(body.apps)
      ? { apps: body.apps.filter((a) => typeof a === "string") }
      : {}),
    ...(typeof body.harness === "string" && body.harness
      ? { harness: body.harness }
      : {}),
    ...(typeof body.model === "string" && body.model
      ? { model: body.model }
      : {}),
    ...(parseHistoryKeep(body.historyKeep) === undefined
      ? {}
      : { historyKeep: parseHistoryKeep(body.historyKeep) }),
    ...(typeof body.onFailure === "string" && body.onFailure
      ? { onFailure: body.onFailure }
      : {}),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(vaultInput === undefined ? {} : { vault: vaultInput }),
    ...(connectorInput === undefined ? {} : { connector: connectorInput }),
    ...(connectionsInput === undefined
      ? {}
      : { connections: connectionsInput }),
  });
  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  await stageAndMaybePublish(opts, {
    appId: id,
    sessionId,
    files,
    publish,
    message: `scaffold automation ${id}`,
    ephemeralSession,
  });

  let row: unknown = null;
  if (publish) {
    const { rows } = await automation.list(opts.codeAppsDir());
    row = rows.find((r) => r.ownerApp === id) ?? null;
  }
  return sendJson(res, 201, {
    row,
    sessionId,
    staged: !publish,
    ...(webhook ? { webhook } : {}),
  });
}

export async function handleAutomationSetEnabled(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const ref = automation.parseRef(url.searchParams.get("ref") ?? "");
  if (!ref)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "set-enabled needs ?ref=",
    });
  const body = await readJson(req);
  if (typeof body.enabled !== "boolean") {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "set-enabled needs { enabled }",
    });
  }

  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
  const sessionId = explicitSession || defaultSessionId(ref.appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);
  const changed = automation.setEnabledInFiles(
    current as ScaffoldFile[],
    ref.automationId,
    body.enabled
  );
  if (changed.length > 0) {
    await stageAndMaybePublish(opts, {
      appId: ref.appId,
      sessionId,
      files: changed,
      publish,
      message: `toggle ${ref.automationId}`,
      ephemeralSession,
    });
  } else if (ephemeralSession) {
    await opts.store.closeSession(sessionId);
  }
  return sendJson(res, 200, { ok: true, staged: !publish });
}

export async function handleAutomationUpdate(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const rawRef = url.searchParams.get("ref") ?? "";
  const ref = automation.parseRef(rawRef);
  if (!ref)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "update needs ?ref=",
    });
  const body = await readJson(req);

  const nameInput = typeof body.name === "string" ? body.name : undefined;
  const promptInput = typeof body.prompt === "string" ? body.prompt : undefined;
  const triggersInput = Array.isArray(body.triggers)
    ? (body.triggers as Array<Record<string, unknown>>)
    : undefined;
  const vaultInput =
    body.vault !== null &&
    typeof body.vault === "object" &&
    !Array.isArray(body.vault)
      ? (body.vault as automation.ManifestVault)
      : undefined;
  const hasConnectorKey = Object.hasOwn(body, "connector");
  const connectorInput = hasConnectorKey
    ? body.connector === null
      ? null
      : body.connector !== null &&
          typeof body.connector === "object" &&
          !Array.isArray(body.connector)
        ? (body.connector as automation.ConnectorSpec)
        : undefined
    : undefined;
  const hasConnectionsKey = Object.hasOwn(body, "connections");
  const connectionsInput = hasConnectionsKey
    ? Array.isArray(body.connections)
      ? (body.connections as automation.ConnectionBinding[])
      : undefined
    : undefined;
  const hasHarnessKey = Object.hasOwn(body, "harness");
  const hasModelKey = Object.hasOwn(body, "model");
  const hasEnrichVariantKey = Object.hasOwn(body, "recognitionStep");
  if (
    opts.isSystemManagedAutomation?.(`${ref.appId}/${ref.automationId}`) &&
    (nameInput !== undefined ||
      promptInput !== undefined ||
      triggersInput !== undefined ||
      vaultInput !== undefined ||
      hasConnectorKey ||
      hasConnectionsKey)
  ) {
    const refused = refuseSystemRecipeMutation(
      opts,
      res,
      ref,
      "editing its name, instructions, triggers, access, or connections"
    );
    if (refused) return refused;
  }
  if (
    nameInput === undefined &&
    promptInput === undefined &&
    triggersInput === undefined &&
    vaultInput === undefined &&
    !hasConnectorKey &&
    !hasConnectionsKey &&
    !hasHarnessKey &&
    !hasModelKey &&
    !hasEnrichVariantKey
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message:
        "update needs at least one of { name, prompt, triggers, connections, connector, harness, model, recognitionStep }",
    });
  }

  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
  const sessionId = explicitSession || defaultSessionId(ref.appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);

  const targetPath = `automations/${ref.automationId}/${automation.MANIFEST_FILE}`;
  const file = current.find((f) => f.path === targetPath);
  if (!file) {
    if (ephemeralSession) await opts.store.closeSession(sessionId);
    return sendJson(res, 404, {
      error: "not_found",
      message: `Automation "${rawRef}" does not exist.`,
    });
  }

  const existing = automation.parseManifest(file.content);

  const ALLOWED_TRIGGER_KINDS = new Set([
    "cron",
    "webhook",
    "condition",
    "data",
    "event",
  ]);
  let webhook: { id: string; secret: string; url: string } | undefined;
  let triggers: automation.Trigger[] | undefined;
  if (triggersInput) {
    const badKind = triggersInput.find(
      (t) =>
        t.kind !== undefined && !ALLOWED_TRIGGER_KINDS.has(t.kind as string)
    );
    if (badKind) {
      if (ephemeralSession) await opts.store.closeSession(sessionId);
      return sendJson(res, 400, {
        error: "bad_request",
        message: `Unsupported trigger kind "${String(badKind.kind)}" — update accepts cron, webhook, condition, data and event triggers.`,
      });
    }
    const existingWebhook = automation.webhookTriggerOf(existing.triggers);
    triggers = triggersInput.map((t) => {
      if (t.kind === "webhook") {
        if (existingWebhook) return existingWebhook;
        const wid = automation.generateWebhookId();
        const secret = automation.generateWebhookSecret();
        webhook = { id: wid, secret, url: webhookUrl(req, wid) };
        return {
          kind: "webhook",
          id: wid,
          secretHash: automation.hashWebhookSecret(secret),
        };
      }
      if (t.kind === "condition") {
        return {
          kind: "condition",
          entity: t.entity,
          ...(t.where === undefined ? {} : { where: t.where }),
          ...(t.every === undefined ? {} : { every: t.every }),
        } as automation.Trigger;
      }
      if (t.kind === "data") {
        return {
          kind: "data",
          entities: t.entities,
          ...(t.every === undefined ? {} : { every: t.every }),
        } as automation.Trigger;
      }
      if (t.kind === "event") {
        return {
          kind: "event",
          connectorKind: t.connectorKind,
          event: t.event,
          ...(t.filter === undefined ? {} : { filter: t.filter }),
          ...(t.every === undefined ? {} : { every: t.every }),
        } as automation.Trigger;
      }
      const expr = typeof t.expr === "string" ? t.expr : "0 9 * * *";
      const tz =
        typeof t.tz === "string" && t.tz.trim() ? t.tz.trim() : undefined;
      return {
        kind: "cron",
        expr,
        ...(tz === undefined ? {} : { tz }),
      };
    });
  }

  const patched: Record<string, unknown> = {
    ...existing,
    ...(nameInput === undefined ? {} : { name: nameInput }),
    ...(promptInput === undefined ? {} : { prompt: promptInput }),
    ...(triggers === undefined ? {} : { triggers }),
    ...(vaultInput === undefined ? {} : { vault: vaultInput }),
  };
  if (hasConnectionsKey) {
    if (connectionsInput === undefined) {
      return sendJson(res, 400, {
        error: "bad_request",
        message: "connections must be an array when provided",
      });
    }
    if (connectionsInput.length === 0) delete patched.connections;
    else patched.connections = connectionsInput;
  }
  if (hasConnectorKey) {
    if (connectorInput === null) delete patched.connector;
    else if (connectorInput !== undefined) patched.connector = connectorInput;
  }
  if (hasHarnessKey || hasModelKey) {
    const requires = { ...existing.requires } as Record<string, unknown>;
    if (hasHarnessKey) {
      if (body.harness === null) delete requires.harness;
      else requires.harness = body.harness;
    }
    if (hasModelKey) {
      if (body.model === null) delete requires.model;
      else requires.model = body.model;
    }
    patched.requires = requires;
  }
  if (hasEnrichVariantKey) {
    if (
      body.recognitionStep !== "deterministic" &&
      body.recognitionStep !== "delegate"
    ) {
      if (ephemeralSession) await opts.store.closeSession(sessionId);
      return sendJson(res, 400, {
        error: "bad_request",
        message: "recognitionStep must be deterministic or delegate",
      });
    }
    const enrich = existing.enrich;
    if (!enrich?.delegateStep) {
      if (ephemeralSession) await opts.store.closeSession(sessionId);
      return sendJson(res, 400, {
        error: "bad_request",
        message:
          "recognitionStep is only valid for a recognition recipe with a delegate step",
      });
    }
    const requires = patched.requires as Record<string, unknown>;
    if (body.recognitionStep === "delegate" && !requires.model) {
      if (ephemeralSession) await opts.store.closeSession(sessionId);
      return sendJson(res, 400, {
        error: "bad_request",
        message:
          "delegate recognition requires an explicit pinned model before provider egress can be consented",
      });
    }
    patched.enrich = {
      ...enrich,
      delegateStep: { ...enrich.delegateStep, selected: body.recognitionStep },
    };
  }
  const manifest = automation.validateManifest(patched);
  const changedFile: ScaffoldFile = {
    path: targetPath,
    content: JSON.stringify(manifest, null, 2) + "\n",
  };

  await stageAndMaybePublish(opts, {
    appId: ref.appId,
    sessionId,
    files: [changedFile],
    publish,
    message: `update ${ref.automationId}`,
    ephemeralSession,
  });

  let row: unknown = null;
  if (publish) {
    const { rows } = await automation.list(opts.codeAppsDir());
    const wantRef = `${ref.appId}/${ref.automationId}`;
    row = rows.find((r) => r.ref === wantRef) ?? null;
  }
  return sendJson(res, 200, {
    row,
    staged: !publish,
    ...(webhook ? { webhook } : {}),
  });
}

export async function handleAutomationRotateWebhook(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const rawRef = url.searchParams.get("ref") ?? "";
  const ref = automation.parseRef(rawRef);
  if (!ref) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "rotate-webhook needs ?ref=",
    });
  }
  const refused = refuseSystemRecipeMutation(
    opts,
    res,
    ref,
    "webhook rotation"
  );
  if (refused) return refused;
  const body = await readJson(req);
  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
  const sessionId = explicitSession || defaultSessionId(ref.appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);

  const targetPath = `automations/${ref.automationId}/${automation.MANIFEST_FILE}`;
  if (!current.some((f) => f.path === targetPath)) {
    if (ephemeralSession) await opts.store.closeSession(sessionId);
    return sendJson(res, 404, {
      error: "not_found",
      message: `Automation "${rawRef}" does not exist.`,
    });
  }

  const { changed, rotated } = automation.rotateWebhookInFiles(
    current as ScaffoldFile[],
    ref.automationId
  );
  if (!rotated) {
    if (ephemeralSession) await opts.store.closeSession(sessionId);
    return sendJson(res, 400, {
      error: "bad_request",
      message: `Automation "${rawRef}" has no webhook trigger to rotate.`,
    });
  }

  await stageAndMaybePublish(opts, {
    appId: ref.appId,
    sessionId,
    files: changed,
    publish,
    message: `rotate webhook secret for ${ref.automationId}`,
    ephemeralSession,
  });

  return sendJson(res, 200, {
    ok: true,
    staged: !publish,
    webhook: {
      id: rotated.webhookId,
      secret: rotated.secret,
      url: webhookUrl(req, rotated.webhookId),
    },
  });
}

export async function handleEnrichmentToggle(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const body = await readJson(req);
  if (typeof body.enabled !== "boolean") {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "enrichment needs { enabled }",
    });
  }
  const enabled = body.enabled;
  const enricherIds = new Set(
    (await listTemplates())
      .filter((t) => t.category === "Enrichment")
      .map((t) => t.id)
  );
  const { rows } = await automation.list(opts.codeAppsDir());
  const toggled: string[] = [];
  const unchanged: string[] = [];
  async function toggleNext(index: number): Promise<void> {
    const row = rows[index];
    if (!row) return;
    if (!enricherIds.has(row.ownerApp)) return toggleNext(index + 1);
    if (row.enabled === enabled) {
      unchanged.push(row.ref);
      return toggleNext(index + 1);
    }
    const sessionId = defaultSessionId(row.ownerApp);
    await prepareLifecycleSession(opts.store, sessionId, true);
    const appDir = await opts.store.snapshotSessionAppDir(
      sessionId,
      row.ownerApp
    );
    const current = await readFileMap(appDir);
    const changed = automation.setEnabledInFiles(
      current as ScaffoldFile[],
      row.id,
      enabled
    );
    if (changed.length > 0) {
      await stageAndMaybePublish(opts, {
        appId: row.ownerApp,
        sessionId,
        files: changed,
        publish: true,
        message: `${enabled ? "enable" : "disable"} enrichment (${row.id})`,
        ephemeralSession: true,
      });
      toggled.push(row.ref);
    } else {
      await opts.store.closeSession(sessionId);
      unchanged.push(row.ref);
    }
    return toggleNext(index + 1);
  }
  await toggleNext(0);
  return sendJson(res, 200, { ok: true, enabled, toggled, unchanged });
}

export async function handleAutomationDelete(
  opts: LifecycleRouteOptions,
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const ref = automation.parseRef(url.searchParams.get("ref") ?? "");
  if (!ref)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "delete needs ?ref=",
    });
  const refused = refuseSystemRecipeMutation(opts, res, ref, "deletion");
  if (refused) return refused;
  const publish = url.searchParams.get("publish") === "true";

  const apps = await opts.store.listAppsWithMeta().catch(() => []);
  const appKind = apps.find((a) => a.id === ref.appId)?.kind;

  if (appKind === "automation") {
    await deleteAppAndReconcile(opts, ref.appId);
    return sendJson(res, 200, { ok: true, deletedApp: true });
  }

  const sessionId = defaultSessionId(ref.appId);
  await prepareLifecycleSession(opts.store, sessionId, true);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);
  const { removed } = automation.deleteFromFiles(
    current as ScaffoldFile[],
    ref.automationId
  );
  if (removed.length === 0) {
    await opts.store.closeSession(sessionId);
    return sendJson(res, 200, { ok: true, staged: !publish });
  }

  await Promise.all(
    removed.map((rel) => fs.rm(nodePath.resolve(appDir, rel), { force: true }))
  );
  if (publish) {
    await publishAndReconcile(opts, {
      appId: ref.appId,
      sessionId,
      appDir,
      message: `delete automation ${ref.automationId}`,
      ephemeralSession: true,
    });
  } else {
    await opts.ensureRegistered(ref.appId);
  }
  return sendJson(res, 200, { ok: true, staged: !publish });
}
