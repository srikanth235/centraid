// HTTP surface for the gateway-owned app lifecycle (#141): the deterministic
// builder lives in the gateway, so a local and a remote gateway behave alike.
// Each verb returns `false` so the apps-store and automations handlers keep
// their own routes.
//
// STAGE VS PUBLISH. Every mutation stages into a session worktree. A falsy
// `publish` (the default, #141/C6) only REGISTERS the app so its draft
// previews; true validates, merges onto `main`, and reconciles cron.
//
// Webhook secrets are minted gateway-side: the plaintext returns ONCE and only
// the hash reaches the manifest on `main`.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AppScaffoldError,
  cloneTemplateFiles,
  readTemplateFiles,
  resolveTemplates,
  suggestCloneIdentityFrom,
  updateAppMetaFiles,
} from "@centraid/blueprints";
import type { ScaffoldFile } from "@centraid/blueprints";
import { provisionPendingWebhooksInFiles } from "@centraid/server/automation";

import {
  defaultSessionId,
  prepareLifecycleSession,
  sendLifecycleError,
  stageAndMaybePublish,
  webhookUrl,
} from "../lifecycle/lifecycle-shared.js";
import type { LifecycleRouteOptions } from "../lifecycle/lifecycle-shared.js";
import {
  handleAutomationCreate,
  handleAutomationCompile,
  handleAutomationDelete,
  handleAutomationRotateWebhook,
  handleAutomationRevise,
  handleAutomationSetEnabled,
  handleAutomationUpdate,
  handleEnrichmentToggle,
} from "./lifecycle-automation-routes.js";
import { readFileMap, readJson, sendJson } from "./route-helpers.js";

export type { LifecycleRouteOptions } from "../lifecycle/lifecycle-shared.js";

export function makeLifecycleRouteHandler(
  opts: LifecycleRouteOptions
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;
    const method = (req.method ?? "GET").toUpperCase();

    const isApps =
      pathname === "/centraid/_apps" || pathname.startsWith("/centraid/_apps/");
    const isAutomations = pathname.startsWith("/centraid/_automations");
    if (!isApps && !isAutomations) return false;

    try {
      if (pathname === "/centraid/_apps/_clone" && method === "POST") {
        return await handleClone(opts, req, res);
      }
      if (pathname === "/centraid/_apps/_install" && method === "POST") {
        return await handleInstall(opts, req, res);
      }
      const metaMatch = /^\/centraid\/_apps\/(?<appId>[^/]+)\/meta$/u.exec(
        pathname
      );
      if (metaMatch && method === "POST") {
        return await handleMeta(
          opts,
          req,
          res,
          decodeURIComponent(metaMatch.groups?.appId ?? "")
        );
      }
      if (pathname === "/centraid/_automations" && method === "POST") {
        return await handleAutomationCreate(opts, req, res);
      }
      if (pathname === "/centraid/_automations/compile" && method === "POST") {
        return await handleAutomationCompile(opts, req, res, url);
      }
      if (pathname === "/centraid/_automations/revise" && method === "POST") {
        return await handleAutomationRevise(opts, req, res, url);
      }
      if (
        pathname === "/centraid/_automations/set-enabled" &&
        method === "POST"
      ) {
        return await handleAutomationSetEnabled(opts, req, res, url);
      }
      if (pathname === "/centraid/_automations/update" && method === "POST") {
        return await handleAutomationUpdate(opts, req, res, url);
      }
      if (
        pathname === "/centraid/_automations/rotate-webhook" &&
        method === "POST"
      ) {
        return await handleAutomationRotateWebhook(opts, req, res, url);
      }
      if (
        pathname === "/centraid/_automations/enrichment" &&
        method === "POST"
      ) {
        return await handleEnrichmentToggle(opts, req, res);
      }
      if (pathname === "/centraid/_automations" && method === "DELETE") {
        return await handleAutomationDelete(opts, req, res, url);
      }
      return false;
    } catch (error) {
      return sendLifecycleError(res, error);
    }
  };
}

async function handleClone(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const body = await readJson(req);
  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  if (!templateId) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "clone needs { templateId }",
    });
  }
  const publish = body.publish === true;

  // A bundled blueprint APP installs in place, never clones (#434); a clone
  // would fork it into the code store. Automation templates still clone.
  if (opts.isBundledAppId?.(templateId)) {
    throw new AppScaffoldError(
      "already_exists",
      `"${templateId}" is a bundled app — install it via /centraid/_apps/_install, not clone.`
    );
  }

  const cacheOpt = opts.templatesCacheDir
    ? { cacheDir: opts.templatesCacheDir }
    : {};
  const templates = await resolveTemplates(cacheOpt);
  const tmpl = templates.find((t) => t.id === templateId);
  if (!tmpl)
    throw new AppScaffoldError(
      "not_found",
      `Unknown template "${templateId}".`
    );

  const existing = await opts.store.listAppsWithMeta();
  const { id: newAppId, name: newName } = suggestCloneIdentityFrom(
    existing,
    tmpl.id,
    tmpl.name
  );
  const templateFiles = await readTemplateFiles(tmpl, cacheOpt);
  const cloned = cloneTemplateFiles({
    newAppId,
    templateFiles,
    newName,
    newDesc: tmpl.desc,
    // Backfill only (#263): a declaring app.json wins in `cloneTemplateFiles`.
    iconKey: tmpl.iconKey,
    colorKey: tmpl.colorKey,
  });

  // Templates ship `{kind:'webhook',pending:true}`; only the hash persists.
  const { files: provisioned, minted } = provisionPendingWebhooksInFiles(
    cloned,
    newAppId
  );
  const webhooks = minted.map((m) => ({
    automationId: m.automationId,
    ownerApp: m.ownerApp,
    webhookId: m.webhookId,
    secret: m.secret,
    url: webhookUrl(req, m.webhookId),
  }));

  const explicitSession =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
  const sessionId = explicitSession || defaultSessionId(newAppId);
  const ephemeralSession = !explicitSession;
  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  await stageAndMaybePublish(opts, {
    appId: newAppId,
    sessionId,
    files: provisioned,
    publish,
    message: `clone ${tmpl.id}`,
    ephemeralSession,
  });

  return sendJson(res, 201, {
    app: {
      id: newAppId,
      name: newName,
      ...(tmpl.desc === undefined ? {} : { description: tmpl.desc }),
      kind: tmpl.kind ?? "app",
    },
    template: {
      id: tmpl.id,
      name: tmpl.name,
      desc: tmpl.desc,
      colorKey: tmpl.colorKey,
      iconKey: tmpl.iconKey,
      version: tmpl.version,
      kind: tmpl.kind ?? "app",
    },
    webhooks,
    sessionId,
    staged: !publish,
  });
}

async function handleInstall(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const body = await readJson(req);
  const templateId = typeof body.templateId === "string" ? body.templateId : "";
  if (!templateId) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "install needs { templateId }",
    });
  }
  if (!opts.installBundledApp) {
    return sendJson(res, 400, {
      error: "no_vault_plane",
      message: "install requires a vault plane",
    });
  }
  const installed = await opts.installBundledApp(templateId);
  if (!installed) {
    throw new AppScaffoldError(
      "not_found",
      `Unknown bundled app "${templateId}".`
    );
  }
  const { alreadyInstalled, ...app } = installed;
  // 200, not 201: install is idempotent.
  return sendJson(res, 200, { app, installed: true, alreadyInstalled });
}

async function handleMeta(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string
): Promise<boolean> {
  if (!appId)
    return sendJson(res, 400, {
      error: "bad_request",
      message: "meta needs an app id",
    });
  if (opts.isSystemManagedApp?.(appId))
    return sendJson(res, 403, {
      error: "system_recipe_read_only",
      message: `${appId} is a release-managed recognition recipe; its app metadata cannot be edited.`,
    });
  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name : undefined;
  const description =
    typeof body.description === "string" ? body.description : undefined;
  const publish = body.publish === true;

  // A bundled app's code is read-only (#434): a rename sets the per-vault
  // label override, null clears it, and false falls through to the code store.
  if (name !== undefined && opts.renameBundledApp?.(appId, name)) {
    return sendJson(res, 200, { ok: true, staged: false });
  }
  const explicitSession =
    typeof body.sessionId === "string" && body.sessionId ? body.sessionId : "";
  const sessionId = explicitSession || defaultSessionId(appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, appId);
  const [current, existing] = await Promise.all([
    readFileMap(appDir),
    opts.store.listAppsWithMeta(),
  ]);
  const changed = updateAppMetaFiles(
    current as ScaffoldFile[],
    appId,
    {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
    },
    existing
  );
  if (changed.length > 0) {
    await stageAndMaybePublish(opts, {
      appId,
      sessionId,
      files: changed,
      publish,
      message: `update meta ${appId}`,
      ephemeralSession,
    });
  } else if (ephemeralSession) {
    // A throwaway session may be open above: close it or it orphans a worktree.
    await opts.store.closeSession(sessionId);
  }
  return sendJson(res, 200, { ok: true, staged: !publish });
}
