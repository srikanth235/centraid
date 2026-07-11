/**
 * Webhook trigger dispatch (issue #96).
 *
 * A `webhook` trigger fires an automation on an inbound HTTP POST. Every
 * host that can be someone's always-on gateway mounts a listener: the
 * openclaw plugin registers a single prefix route at `/_centraid-hook`
 * (`auth: 'plugin'`, no gateway bearer), and the core gateway
 * (`packages/gateway/src/serve/build-gateway.ts`) mounts the equivalent
 * ahead of its own bearer check — the desktop/daemon gateway IS the
 * always-on gateway for desktop-only users (there is no separate remote
 * host in that topology). Both mountings hand every request to
 * `makeWebhookRouteHandler` built here.
 *
 * Auth copies the stock openclaw `webhooks` plugin recipe: a shared
 * secret carried as `Authorization: Bearer <secret>` or the
 * `x-openclaw-webhook-secret` header. The secret is generated
 * server-side and shown once at creation — `automation.json` stores
 * only a SHA-256 hash, since the manifest file is user-visible.
 *
 * The handler also enforces a body-size cap, a fixed-window rate limit,
 * and a single-in-flight guard per webhook id. Running the resolved
 * automation is delegated to the caller-supplied `fire` callback
 * (`runOpenclawFire` on the gateway) so this module stays free of any
 * openclaw dependency.
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { APP_AUTOMATIONS_SUBDIR, list, readAppAt, writeManifestAt } from './app.js';
import {
  isPendingWebhookTrigger,
  parseManifest,
  pendingWebhookTriggerOf,
  webhookTriggerOf,
  type Trigger,
  type WebhookTrigger,
} from '../manifest/manifest.js';

/** URL prefix the gateway mounts the webhook route under. */
export const WEBHOOK_ROUTE_PREFIX = '/_centraid-hook';

/** Largest request body the webhook route accepts (64 KiB). */
const MAX_BODY_BYTES = 64 * 1024;

/** Fixed-window rate limit: at most this many fires per window, per webhook. */
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Generate a fresh webhook route slug (the path segment under the prefix). */
export function generateWebhookId(): string {
  return crypto.randomBytes(12).toString('hex');
}

/** Generate a fresh shared secret — shown to the user once, never stored raw. */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** SHA-256 hex of a secret — this is what the manifest persists. */
export function hashWebhookSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Timing-safe check of a presented secret against a stored hash. */
export function verifyWebhookSecret(provided: string, expectedHash: string): boolean {
  const a = Buffer.from(hashWebhookSecret(provided), 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

/**
 * A webhook freshly minted by the provisioning pass. `secret` is the
 * plaintext shared secret — surfaced to the user exactly once and never
 * persisted; the manifest keeps only its SHA-256 hash.
 */
export interface ProvisionedWebhook {
  /** Automation app directory. */
  readonly dir: string;
  /** Automation id (the directory basename). */
  readonly automationId: string;
  /** Owning app id — every automation is app-owned (issue #98). */
  readonly ownerApp: string;
  /** Minted webhook route slug — the path segment under the prefix. */
  readonly webhookId: string;
  /** Plaintext shared secret — shown once, never written to disk. */
  readonly secret: string;
}

/**
 * Provision a pending webhook trigger in the automation app at
 * `dir`. A pending trigger — `{ kind: 'webhook', pending: true }` — is
 * what the builder agent writes when the user asks for a webhook: the
 * agent cannot mint crypto-random credentials. This pass mints a route
 * id + secret, rewrites the trigger to its provisioned form, and
 * persists the manifest. Returns the minted secret (to be shown once)
 * or `undefined` when the app has no pending webhook.
 */
export async function provisionPendingWebhookAt(
  dir: string,
  ownerApp: string,
): Promise<ProvisionedWebhook | undefined> {
  const row = await readAppAt(dir, ownerApp);
  if (!row) return undefined;
  if (!pendingWebhookTriggerOf(row.triggers)) return undefined;

  const webhookId = generateWebhookId();
  const secret = generateWebhookSecret();
  const provisioned: WebhookTrigger = {
    kind: 'webhook',
    id: webhookId,
    secretHash: hashWebhookSecret(secret),
  };
  const triggers: Trigger[] = row.triggers.map((t) =>
    isPendingWebhookTrigger(t) ? provisioned : t,
  );
  await writeManifestAt(dir, { ...row.manifest, triggers });
  return { dir, automationId: row.id, ownerApp, webhookId, secret };
}

/**
 * Provision every pending webhook across an app's owned automations at
 * `<appDir>/automations/<id>/` (issue #98). A missing `automations/`
 * subdir contributes nothing. Each entry's `ownerApp` is the app id.
 */
export async function provisionAppPendingWebhooks(appDir: string): Promise<ProvisionedWebhook[]> {
  const autoRoot = path.join(appDir, APP_AUTOMATIONS_SUBDIR);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(autoRoot, { withFileTypes: true });
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  const appId = path.basename(appDir);
  const out: ProvisionedWebhook[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const minted = await provisionPendingWebhookAt(path.join(autoRoot, e.name), appId);
    if (minted) out.push(minted);
  }
  return out;
}

/** A single draft file in a git-store file map (issue #141). */
export interface WebhookFileMapEntry {
  path: string;
  content: string;
}

/** A webhook minted while provisioning a file map. No `dir` — the app is edited over HTTP. */
export interface ProvisionedWebhookInFiles {
  /** The `automation.json` path within the file map. */
  readonly path: string;
  /** Automation id (the `automations/<id>/` segment). */
  readonly automationId: string;
  /** Owning app id. */
  readonly ownerApp: string;
  /** Minted webhook route slug. */
  readonly webhookId: string;
  /** Plaintext shared secret — shown once, never written to disk. */
  readonly secret: string;
}

const AUTOMATION_MANIFEST_RE = /^automations\/([^/]+)\/automation\.json$/;

/**
 * Filesystem-free variant of {@link provisionAppPendingWebhooks} for the
 * git-store/HTTP path (issue #141). Scans a draft file map for pending
 * webhook triggers, mints id + secret for each, rewrites the trigger to
 * its provisioned form, and returns the updated map plus the minted
 * secrets (to be shown once). Secrets are minted here (crypto) and only
 * their hash is written into the manifest, so the plaintext never reaches
 * the gateway. Unparseable / invalid manifests are passed through
 * untouched.
 */
export function provisionPendingWebhooksInFiles(
  files: ReadonlyArray<WebhookFileMapEntry>,
  ownerApp: string,
): { files: WebhookFileMapEntry[]; minted: ProvisionedWebhookInFiles[] } {
  const out: WebhookFileMapEntry[] = [];
  const minted: ProvisionedWebhookInFiles[] = [];
  for (const f of files) {
    const m = AUTOMATION_MANIFEST_RE.exec(f.path);
    if (!m) {
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
      kind: 'webhook',
      id: webhookId,
      secretHash: hashWebhookSecret(secret),
    };
    const triggers: Trigger[] = manifest.triggers.map((t) =>
      isPendingWebhookTrigger(t) ? provisioned : t,
    );
    out.push({ path: f.path, content: JSON.stringify({ ...manifest, triggers }, null, 2) + '\n' });
    minted.push({ path: f.path, automationId: m[1]!, ownerApp, webhookId, secret });
  }
  return { files: out, minted };
}

/** Result of the caller-supplied automation fire. */
export interface WebhookFireResult {
  ok: boolean;
  runId?: string;
  error?: string;
}

/**
 * Runs the resolved automation. Supplied by the gateway host
 * (`runOpenclawFire`) so this module carries no openclaw dependency.
 */
export type WebhookFireFn = (input: {
  /** `<appId>/<automationId>` handle of the resolved automation. */
  automationRef: string;
  body: unknown;
}) => Promise<WebhookFireResult>;

export interface WebhookRouteOptions {
  /** Directory holding the app folders that own the automations. */
  appsDir: string;
  /** Runs the automation once auth + resolution succeed. */
  fire: WebhookFireFn;
}

function extractSecret(req: IncomingMessage): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim() || undefined;
  }
  const header = req.headers['x-openclaw-webhook-secret'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return undefined;
}

async function readBodyCapped(
  req: IncomingMessage,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) return { ok: false };
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    // A non-JSON body is passed through verbatim — the automation
    // handler decides what to do with it.
    return { ok: true, body: text };
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

/**
 * Build the `/_centraid-hook` route handler. Returns `true` when it
 * owns the request (so the gateway stops its route chain), `false`
 * when the URL is not a webhook path.
 */
export function makeWebhookRouteHandler(opts: WebhookRouteOptions) {
  // Per-webhook fixed-window rate-limit + single-in-flight guards.
  // Module-scoped to the closure so each mounted route keeps its own.
  const windows = new Map<string, { start: number; count: number }>();
  const inFlight = new Set<string>();

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

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(WEBHOOK_ROUTE_PREFIX)) return false;
    const url = new URL(req.url, 'http://x');
    const sub = url.pathname.slice(WEBHOOK_ROUTE_PREFIX.length);
    const slug = sub.replace(/^\/+/, '').replace(/\/+$/, '');

    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { error: 'webhook triggers accept POST only' });
      return true;
    }
    if (!slug || !/^[A-Za-z0-9_-]+$/.test(slug)) {
      sendJson(res, 404, { error: 'unknown webhook' });
      return true;
    }
    if (overRateLimit(slug)) {
      sendJson(res, 429, { error: 'rate limit exceeded' });
      return true;
    }
    if (inFlight.has(slug)) {
      sendJson(res, 409, { error: 'a run for this webhook is already in flight' });
      return true;
    }

    try {
      // Resolve the webhook id to its automation. Webhook slugs are
      // globally unique, so the first active-version match wins.
      const { rows } = await list(opts.appsDir);
      const target = rows.find((r) => webhookTriggerOf(r.triggers)?.id === slug);
      if (!target) {
        sendJson(res, 404, { error: 'unknown webhook' });
        return true;
      }
      const trigger = webhookTriggerOf(target.triggers)!;

      const secret = extractSecret(req);
      if (!secret || !verifyWebhookSecret(secret, trigger.secretHash)) {
        sendJson(res, 401, { error: 'invalid or missing webhook secret' });
        return true;
      }
      if (!target.enabled) {
        sendJson(res, 200, { ok: false, skipped: 'automation disabled' });
        return true;
      }

      const body = await readBodyCapped(req);
      if (!body.ok) {
        sendJson(res, 413, { error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
        return true;
      }

      inFlight.add(slug);
      try {
        const result = await opts.fire({ automationRef: target.ref, body: body.body });
        sendJson(res, result.ok ? 200 : 500, result);
      } finally {
        inFlight.delete(slug);
      }
      return true;
    } catch (err) {
      inFlight.delete(slug);
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      return true;
    }
  };
}
