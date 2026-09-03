import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { resolveTemplates, templateSourceDir } from "@centraid/blueprints";
import type { ResolvedTemplate } from "@centraid/blueprints";

import { sendJson } from "./route-helpers.js";

interface TemplateVaultScope {
  schema: string;
  table?: string;
  verbs: string;
}

interface TemplateVault {
  purpose?: string;
  why?: string;
  scopes: TemplateVaultScope[];
}

async function readTemplateVault(
  t: ResolvedTemplate,
  cacheDir?: string
): Promise<TemplateVault | undefined> {
  if ((t.kind ?? "app") === "automation") return undefined;
  try {
    const dir = templateSourceDir(t.id, {
      kind: t.kind ?? "app",
      source: t.source,
      ...(cacheDir ? { cacheDir } : {}),
    });
    const parsed = JSON.parse(
      await fs.readFile(path.join(dir, "app.json"), "utf8")
    ) as {
      vault?: { purpose?: unknown; why?: unknown; scopes?: unknown };
    };
    const vault = parsed.vault;
    if (!vault || !Array.isArray(vault.scopes)) return undefined;
    const scopes: TemplateVaultScope[] = vault.scopes
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({
        schema: String(s.schema ?? ""),
        ...(typeof s.table === "string" ? { table: s.table } : {}),
        verbs: String(s.verbs ?? ""),
      }))
      .filter((s) => s.schema && s.verbs);
    if (scopes.length === 0) return undefined;
    return {
      ...(typeof vault.purpose === "string" ? { purpose: vault.purpose } : {}),
      ...(typeof vault.why === "string" ? { why: vault.why } : {}),
      scopes,
    };
  } catch {
    return undefined;
  }
}

export interface TemplatesRouteOptions {
  cacheDir?: string;

  installedAppIds?: () => Set<string>;
}

export function makeTemplatesRouteHandler(
  opts: TemplatesRouteOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/centraid/_templates") return false;
    if ((req.method ?? "GET").toUpperCase() !== "GET") return false;

    const resolved = await resolveTemplates(
      opts.cacheDir ? { cacheDir: opts.cacheDir } : {}
    );
    const installed = opts.installedAppIds ? opts.installedAppIds() : undefined;
    const vaults = await Promise.all(
      resolved.map((t) => readTemplateVault(t, opts.cacheDir))
    );
    sendJson(
      res,
      200,
      resolved.map((t, i) => ({
        id: t.id,
        name: t.name,
        desc: t.desc,
        colorKey: t.colorKey,
        iconKey: t.iconKey,
        version: t.version,
        ...(installed ? { installed: installed.has(t.id) } : {}),
        ...(vaults[i] ? { vault: vaults[i] } : {}),
        ...(t.kind === undefined ? {} : { kind: t.kind }),
        ...(t.emoji === undefined ? {} : { emoji: t.emoji }),
        ...(t.category === undefined ? {} : { category: t.category }),
        ...(t.triggerKind === undefined ? {} : { triggerKind: t.triggerKind }),
        ...(t.triggerLabel === undefined
          ? {}
          : { triggerLabel: t.triggerLabel }),
        ...(t.integrations === undefined
          ? {}
          : { integrations: t.integrations }),
      }))
    );
    return true;
  };
}
