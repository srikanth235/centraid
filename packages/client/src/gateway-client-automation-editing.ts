/*
 * Automation lifecycle over HTTP. Scaffold-and-clone, not install-in-place:
 * generated code is authored into a session worktree and published into the
 * vault's git code store (#434).
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";
import { dropAppSession, ensureAppSession } from "./gateway-client-editing.js";

/** `condition`/`data` require a paired `vault` grant on the request. */
export type CentraidCreateTrigger =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "webhook" }
  | { kind: "condition"; entity: string; where?: unknown; every?: string }
  | { kind: "data"; entities: string[]; every?: string }
  | {
      kind: "event";
      connectorKind: string;
      event: string;
      filter?: Record<string, unknown>;
      every?: string;
    };

/** Soft connection binding — ids only, no secrets. */
export type CentraidConnectionBinding = {
  connectionId: string;
  kind: string;
  label: string;
};

export type CentraidConnectorSpec = {
  kind: string;
  label: string;
  principal?: string;
  connectionId?: string;
};

export async function createAutomation(input: {
  id: string;
  name?: string;
  description?: string;
  prompt?: string;
  triggers?: CentraidCreateTrigger[];
  /** Required when `triggers` has a condition/data entry. */
  vault?: {
    why?: string;
    scopes: Array<{
      schema: string;
      table?: string;
      verbs: string;
      rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
      fieldMask?: string[];
    }>;
  };
  connections?: CentraidConnectionBinding[];
  connector?: CentraidConnectorSpec;
  apps?: string[];
  harness?: string;
  model?: string;
  historyKeep?: { count: number } | { days: number } | "all" | "errors";
  onFailure?: string;
  enabled?: boolean;
}): Promise<{
  row: CentraidAutomationRow | null;
  webhook?: { id: string; secret: string; url: string };
}> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ ...input, sessionId, publish: true }),
  });
  const out = await readJson<{
    row: CentraidAutomationRow | null;
    webhook?: { id: string; secret: string; url: string };
  }>(res, "create automation");
  return {
    row: out.row ?? null,
    ...(out.webhook ? { webhook: out.webhook } : {}),
  };
}

/**
 * `{kind:'webhook'}` mints a secret only when none existed; keeping an
 * existing webhook leaves the secret untouched — rotate via
 * `rotateAutomationWebhookSecret`.
 */
export async function updateAutomation(input: {
  automationId: string;
  name?: string;
  prompt?: string;
  triggers?: CentraidCreateTrigger[];
  vault?: {
    why?: string;
    scopes: Array<{
      schema: string;
      table?: string;
      verbs: string;
      rowFilter?: Array<{ column: string; op: string; value?: unknown }>;
      fieldMask?: string[];
    }>;
  };
  connections?: CentraidConnectionBinding[];
  connector?: CentraidConnectorSpec | null;
  /** `null` clears the pin and restores the subsystem default. */
  harness?: string | null;
  /** `null` clears the pin and restores the harness default. */
  model?: string | null;
  recognitionStep?: "deterministic" | "delegate";
}): Promise<{
  row: CentraidAutomationRow | null;
  webhook?: { id: string; secret: string; url: string };
}> {
  const appId = input.automationId.split("/")[0] ?? "";
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/update?ref=${enc(input.automationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.triggers === undefined ? {} : { triggers: input.triggers }),
        ...(input.vault === undefined ? {} : { vault: input.vault }),
        ...(input.connections === undefined
          ? {}
          : { connections: input.connections }),
        ...(input.connector === undefined
          ? {}
          : { connector: input.connector }),
        ...(input.harness === undefined ? {} : { harness: input.harness }),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.recognitionStep === undefined
          ? {}
          : { recognitionStep: input.recognitionStep }),
        sessionId,
        publish: true,
      }),
    }
  );
  const out = await readJson<{
    row: CentraidAutomationRow | null;
    webhook?: { id: string; secret: string; url: string };
  }>(res, "update automation");
  return {
    row: out.row ?? null,
    ...(out.webhook ? { webhook: out.webhook } : {}),
  };
}

export async function setAutomationEnabled(input: {
  automationId: string;
  enabled: boolean;
}): Promise<{ ok: true }> {
  const appId = input.automationId.split("/")[0] ?? "";
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/set-enabled?ref=${enc(input.automationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({
        enabled: input.enabled,
        sessionId,
        publish: true,
      }),
    }
  );
  await readJson(res, "set automation enabled");
  return { ok: true };
}

/** Mint a new secret over the SAME route id; the old secret is unrecoverable. */
export async function rotateAutomationWebhookSecret(input: {
  automationId: string;
}): Promise<{ webhook: { id: string; secret: string; url: string } }> {
  const appId = input.automationId.split("/")[0] ?? "";
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/rotate-webhook?ref=${enc(input.automationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ sessionId, publish: true }),
    }
  );
  const out = await readJson<{
    webhook: { id: string; secret: string; url: string };
  }>(res, "rotate automation webhook secret");
  return { webhook: out.webhook };
}

export async function deleteAutomation(input: {
  automationId: string;
}): Promise<{ ok: true }> {
  const appId = input.automationId.split("/")[0] ?? "";
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations?ref=${enc(input.automationId)}&publish=true`,
    { method: "DELETE", headers: authHeaders(token) }
  );
  // Surface a gateway rejection instead of reporting a phantom success.
  const out = await readJson<{ deletedApp?: boolean }>(
    res,
    "delete automation"
  );
  if (out.deletedApp) await dropAppSession(appId);
  return { ok: true };
}
