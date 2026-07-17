/*
 * Renderer-side *automation* lifecycle over direct HTTP. Split out of
 * `gateway-client-editing.ts` (repo file-size limit); the barrel re-exports
 * these so call sites still `import … from './gateway-client.js'`.
 *
 * Automations remain a scaffold-and-clone surface: unlike bundled apps —
 * which install in place from the shipped release (#434) — an automation's
 * code is *generated* (the hidden builder is its compiler), so it is authored
 * into a session worktree and published into the vault's git code store.
 */

import { auth, authHeaders, doFetch, enc, readJson } from './gateway-client-core.js';
import { dropAppSession, ensureAppSession } from './gateway-client-editing.js';

/**
 * A create-time trigger spec. `condition`/`data` are validated gateway-side
 * against the real manifest schema (issue #141 follow-up: the create route
 * used to 400 on anything but cron/webhook) and require a paired `vault`
 * block on the request — the consented read they gate on has to run under
 * some requested grant, or there is nothing for the trigger to evaluate.
 */
export type CentraidCreateTrigger =
  | { kind: 'cron'; expr: string }
  | { kind: 'webhook' }
  | { kind: 'condition'; entity: string; where?: unknown; every?: string }
  | { kind: 'data'; entities: string[]; every?: string };

/** Scaffold a new automation app; mints a webhook secret when requested. */
export async function createAutomation(input: {
  id: string;
  name?: string;
  description?: string;
  prompt?: string;
  triggers?: CentraidCreateTrigger[];
  /** Requested vault access — required when `triggers` has a condition/data entry. */
  vault?: {
    purpose: string;
    why?: string;
    scopes: Array<{ schema: string; table?: string; verbs: string }>;
  };
  apps?: string[];
  model?: string;
  historyKeep?: { count: number } | { days: number } | 'all' | 'errors';
  onFailure?: string;
  enabled?: boolean;
}): Promise<{
  row: CentraidAutomationRow | null;
  webhook?: { id: string; secret: string; url: string };
}> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ ...input, sessionId, publish: true }),
  });
  const out = await readJson<{
    row: CentraidAutomationRow | null;
    webhook?: { id: string; secret: string; url: string };
  }>(res, 'create automation');
  return { row: out.row ?? null, ...(out.webhook ? { webhook: out.webhook } : {}) };
}

/**
 * Patch an automation's `name` / `prompt` (manifest `prompt` — the
 * instructions the builder compiles into `handler.js`) / `triggers` in its
 * draft, then publish. Every field is optional; only a present one is
 * changed — the instructions-first editor's save path, an alternative to
 * routing an edit through the builder chat. Triggers follow the same wire
 * shape `createAutomation` takes; a `{kind:'webhook'}` entry mints a fresh
 * secret (returned once, like create) only when the automation had no
 * webhook trigger before — an edit that keeps an existing one leaves its
 * secret untouched (`rotateAutomationWebhookSecret` is the dedicated way to
 * rotate it). 404s when `automationId` doesn't exist, 400s on an invalid
 * patch (bad trigger kind/shape).
 */
export async function updateAutomation(input: {
  automationId: string;
  name?: string;
  prompt?: string;
  triggers?: CentraidCreateTrigger[];
  vault?: {
    purpose: string;
    why?: string;
    scopes: Array<{ schema: string; table?: string; verbs: string }>;
  };
}): Promise<{
  row: CentraidAutomationRow | null;
  webhook?: { id: string; secret: string; url: string };
}> {
  const appId = input.automationId.split('/')[0] ?? '';
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/update?ref=${enc(input.automationId)}`,
    {
      method: 'POST',
      headers: authHeaders(token, 'application/json'),
      body: JSON.stringify({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
        ...(input.triggers !== undefined ? { triggers: input.triggers } : {}),
        ...(input.vault !== undefined ? { vault: input.vault } : {}),
        sessionId,
        publish: true,
      }),
    },
  );
  const out = await readJson<{
    row: CentraidAutomationRow | null;
    webhook?: { id: string; secret: string; url: string };
  }>(res, 'update automation');
  return { row: out.row ?? null, ...(out.webhook ? { webhook: out.webhook } : {}) };
}

/** Toggle an automation's `enabled` flag in its draft, then publish. */
export async function setAutomationEnabled(input: {
  automationId: string;
  enabled: boolean;
}): Promise<{ ok: true }> {
  const appId = input.automationId.split('/')[0] ?? '';
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/set-enabled?ref=${enc(input.automationId)}`,
    {
      method: 'POST',
      headers: authHeaders(token, 'application/json'),
      body: JSON.stringify({ enabled: input.enabled, sessionId, publish: true }),
    },
  );
  await readJson(res, 'set automation enabled');
  return { ok: true };
}

/**
 * Rotate a webhook-triggered automation's shared secret and publish. The
 * original secret is shown once at mint time (create/clone); an owner who
 * missed that one-time reveal has no other way to recover it — this mints
 * a fresh one over the SAME route id (any already-configured caller URL
 * keeps working) and returns it once, exactly like `createAutomation`'s
 * `webhook` field. 404s when `automationId` doesn't exist, 400s when it has
 * no webhook trigger to rotate.
 */
export async function rotateAutomationWebhookSecret(input: {
  automationId: string;
}): Promise<{ webhook: { id: string; secret: string; url: string } }> {
  const appId = input.automationId.split('/')[0] ?? '';
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/rotate-webhook?ref=${enc(input.automationId)}`,
    {
      method: 'POST',
      headers: authHeaders(token, 'application/json'),
      body: JSON.stringify({ sessionId, publish: true }),
    },
  );
  const out = await readJson<{ webhook: { id: string; secret: string; url: string } }>(
    res,
    'rotate automation webhook secret',
  );
  return { webhook: out.webhook };
}

/** Remove an automation (whole app or in-app subdir), then publish. */
export async function deleteAutomation(input: { automationId: string }): Promise<{ ok: true }> {
  const appId = input.automationId.split('/')[0] ?? '';
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations?ref=${enc(input.automationId)}&publish=true`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
  // Surface a gateway rejection instead of reporting a phantom success.
  const out = await readJson<{ deletedApp?: boolean }>(res, 'delete automation');
  // A whole-automation-app delete drops the app; forget its session too.
  if (out.deletedApp) await dropAppSession(appId);
  return { ok: true };
}
