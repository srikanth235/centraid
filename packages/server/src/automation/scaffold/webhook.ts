// Webhook trigger dispatch (#96): the gateway mounts `makeWebhookRouteHandler`
// at `/_centraid-hook`, ahead of its own bearer check. The shared secret is
// minted server-side and shown once — `automation.json` is user-visible, so
// only its SHA-256 hash is stored. After auth the handler writes a durable
// ingress element, so a restarted fire can never drop a delivery.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type * as TypeImport_g9tn66 from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import {
  isPendingWebhookTrigger,
  MANIFEST_FILE,
  parseManifest,
  pendingWebhookTriggerOf,
  webhookTriggerOf,
} from "../manifest/manifest.js";
import type { Trigger, WebhookTrigger } from "../manifest/manifest.js";
import {
  APP_AUTOMATIONS_SUBDIR,
  list,
  readAppAt,
  writeManifestAt,
} from "./app.js";

export const WEBHOOK_ROUTE_PREFIX = "/_centraid-hook";

/** 64 KiB. */
const MAX_BODY_BYTES = 64 * 1024;

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

export function generateWebhookId(): string {
  return crypto.randomBytes(12).toString("hex");
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(24).toString("hex");
}

/** What the manifest persists. */
export function hashWebhookSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function verifyWebhookSecret(
  provided: string,
  expectedHash: string
): boolean {
  const a = Buffer.from(hashWebhookSecret(provided), "hex");
  const b = Buffer.from(expectedHash, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "ENOENT"
  );
}

export interface ProvisionedWebhook {
  readonly dir: string;
  readonly automationId: string;
  readonly ownerApp: string;
  readonly webhookId: string;
  /** Never written to disk. */
  readonly secret: string;
}

/** A pending trigger is what the builder harness writes: it cannot mint
 *  crypto-random credentials. */
export async function provisionPendingWebhookAt(
  dir: string,
  ownerApp: string
): Promise<ProvisionedWebhook | undefined> {
  const row = await readAppAt(dir, ownerApp);
  if (!row) return undefined;
  if (!pendingWebhookTriggerOf(row.triggers)) return undefined;

  const webhookId = generateWebhookId();
  const secret = generateWebhookSecret();
  const provisioned: WebhookTrigger = {
    kind: "webhook",
    id: webhookId,
    secretHash: hashWebhookSecret(secret),
  };
  const triggers: Trigger[] = row.triggers.map((t) =>
    isPendingWebhookTrigger(t) ? provisioned : t
  );
  await writeManifestAt(dir, { ...row.manifest, triggers });
  return { dir, automationId: row.id, ownerApp, webhookId, secret };
}

export async function provisionAppPendingWebhooks(
  appDir: string
): Promise<ProvisionedWebhook[]> {
  const autoRoot = path.join(appDir, APP_AUTOMATIONS_SUBDIR);
  let entries: TypeImport_g9tn66.Dirent[];
  try {
    entries = await fs.readdir(autoRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const appId = path.basename(appDir);
  const minted = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith(".") &&
          !entry.name.startsWith("_")
      )
      .map((entry) =>
        provisionPendingWebhookAt(path.join(autoRoot, entry.name), appId)
      )
  );
  return minted.filter(
    (webhook): webhook is ProvisionedWebhook => webhook !== undefined
  );
}

export interface WebhookFileMapEntry {
  path: string;
  content: string;
}

export interface ProvisionedWebhookInFiles {
  readonly path: string;
  readonly automationId: string;
  readonly ownerApp: string;
  readonly webhookId: string;
  /** Never written to disk. */
  readonly secret: string;
}

const AUTOMATION_MANIFEST_RE =
  /^automations\/(?<automationId>[^/]+)\/automation\.json$/u;

/** Only the hash is written, so plaintext never reaches the gateway (#141). */
export function provisionPendingWebhooksInFiles(
  files: ReadonlyArray<WebhookFileMapEntry>,
  ownerApp: string
): { files: WebhookFileMapEntry[]; minted: ProvisionedWebhookInFiles[] } {
  const out: WebhookFileMapEntry[] = [];
  const minted: ProvisionedWebhookInFiles[] = [];
  for (const f of files) {
    const automationId = AUTOMATION_MANIFEST_RE.exec(f.path)?.groups
      ?.automationId;
    if (!automationId) {
      out.push(f);
      continue;
    }
    let manifest;
    try {
      manifest = parseManifest(f.content);
    } catch {
      out.push(f); // invalid manifest — leave it for the publish-time validator.
      continue;
    }
    if (!pendingWebhookTriggerOf(manifest.triggers)) {
      out.push(f);
      continue;
    }
    const webhookId = generateWebhookId();
    const secret = generateWebhookSecret();
    const provisioned: WebhookTrigger = {
      kind: "webhook",
      id: webhookId,
      secretHash: hashWebhookSecret(secret),
    };
    const triggers: Trigger[] = manifest.triggers.map((t) =>
      isPendingWebhookTrigger(t) ? provisioned : t
    );
    out.push({
      path: f.path,
      content: JSON.stringify({ ...manifest, triggers }, null, 2) + "\n",
    });
    minted.push({ path: f.path, automationId, ownerApp, webhookId, secret });
  }
  return { files: out, minted };
}

export interface RotatedWebhookInFiles {
  readonly path: string;
  /** Unchanged, so any configured caller URL survives a rotation. */
  readonly webhookId: string;
  /** Never written to disk. */
  readonly secret: string;
}

/** Rotate a PROVISIONED webhook's secret in a draft file map (#141). Only the
 *  hash persists, so an owner who missed the one-time reveal is left with an
 *  uncallable automation. The route id is kept, so a configured caller keeps
 *  working. `undefined` for a still-`pending` trigger: it needs a first mint. */
export function rotateWebhookInFiles(
  current: ReadonlyArray<WebhookFileMapEntry>,
  automationId: string
): { changed: WebhookFileMapEntry[]; rotated?: RotatedWebhookInFiles } {
  const target = `${APP_AUTOMATIONS_SUBDIR}/${automationId}/${MANIFEST_FILE}`;
  const file = current.find((f) => f.path === target);
  if (!file) return { changed: [] };

  let manifest;
  try {
    manifest = parseManifest(file.content);
  } catch {
    return { changed: [] }; // unparseable — leave it for the publish-time validator.
  }
  const existing = webhookTriggerOf(manifest.triggers);
  if (!existing) return { changed: [] };

  const secret = generateWebhookSecret();
  const provisioned: WebhookTrigger = {
    kind: "webhook",
    id: existing.id,
    secretHash: hashWebhookSecret(secret),
  };
  const triggers: Trigger[] = manifest.triggers.map((t) =>
    t === existing ? provisioned : t
  );
  const changedFile: WebhookFileMapEntry = {
    path: target,
    content: JSON.stringify({ ...manifest, triggers }, null, 2) + "\n",
  };
  return {
    changed: [changedFile],
    rotated: { path: target, webhookId: existing.id, secret },
  };
}

export interface WebhookIngressResult {
  accepted: boolean;
  duplicate?: boolean;
  error?: string;
}

export type WebhookIngressFn = (input: {
  automationRef: string;
  webhookId: string;
  deliveryId: string;
  receivedAt: number;
  body: unknown;
}) => Promise<WebhookIngressResult>;

export interface WebhookRouteOptions {
  appsDir: string;
  ingress: WebhookIngressFn;
}

function extractSecret(req: IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && /^Bearer\s+/iu.test(auth)) {
    return auth.replace(/^Bearer\s+/iu, "").trim() || undefined;
  }
  const header = req.headers["x-openclaw-webhook-secret"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return undefined;
}

/** Only headers that are per-delivery BY CONTRACT: `x-request-id` is reused by
 *  some proxies, which would collapse two deliveries into one. */
function deliveryId(req: IncomingMessage): string {
  for (const name of ["x-centraid-delivery-id", "x-github-delivery"]) {
    const value = req.headers[name];
    if (typeof value === "string" && value.trim())
      return value.trim().slice(0, 256);
  }
  return crypto.randomUUID();
}

async function readBodyCapped(
  req: IncomingMessage
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) return { ok: false };
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: true, body: text };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

/** `true` when it owns the request, so the gateway stops its chain. */
export function makeWebhookRouteHandler(opts: WebhookRouteOptions) {
  // Scoped to the closure, so each mounted route keeps its own limiter.
  const windows = new Map<string, { start: number; count: number }>();

  const overRateLimit = (webhookId: string): boolean => {
    const now = Date.now();
    const w = windows.get(webhookId);
    if (!w || now - w.start >= RATE_LIMIT_WINDOW_MS) {
      windows.set(webhookId, { start: now, count: 1 });
      return false;
    }
    w.count += 1;
    return w.count > RATE_LIMIT_MAX;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(WEBHOOK_ROUTE_PREFIX)) return false;
    const url = new URL(req.url, "http://x");
    const sub = url.pathname.slice(WEBHOOK_ROUTE_PREFIX.length);
    const slug = sub.replace(/^\/+/u, "").replace(/\/+$/u, "");

    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      sendJson(res, 405, { error: "webhook triggers accept POST only" });
      return true;
    }
    if (!slug || !/^[A-Za-z0-9_-]+$/u.test(slug)) {
      sendJson(res, 404, { error: "unknown webhook" });
      return true;
    }
    if (overRateLimit(slug)) {
      sendJson(res, 429, { error: "rate limit exceeded" });
      return true;
    }
    try {
      // Webhook slugs are globally unique, so the first active-version match wins.
      const { rows } = await list(opts.appsDir);
      const target = rows.find(
        (r) => webhookTriggerOf(r.triggers)?.id === slug
      );
      if (!target) {
        sendJson(res, 404, { error: "unknown webhook" });
        return true;
      }
      const trigger = webhookTriggerOf(target.triggers)!;

      const secret = extractSecret(req);
      if (!secret || !verifyWebhookSecret(secret, trigger.secretHash)) {
        sendJson(res, 401, { error: "invalid or missing webhook secret" });
        return true;
      }
      if (!target.enabled) {
        sendJson(res, 200, { ok: false, skipped: "automation disabled" });
        return true;
      }

      const body = await readBodyCapped(req);
      if (!body.ok) {
        sendJson(res, 413, {
          error: `request body exceeds ${MAX_BODY_BYTES} bytes`,
        });
        return true;
      }

      const id = deliveryId(req);
      const result = await opts.ingress({
        automationRef: target.ref,
        webhookId: slug,
        deliveryId: id,
        receivedAt: Date.now(),
        body: body.body,
      });
      sendJson(res, result.accepted ? 202 : 500, { ...result, deliveryId: id });
      return true;
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };
}
