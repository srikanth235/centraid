import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

/** Start the hidden compile path; the returned run appears in the automation thread. */
export async function compileAutomation(input: {
  automationId: string;
  enableOnSuccess?: boolean;
}): Promise<{ compileTurnId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/compile?ref=${enc(input.automationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ enableOnSuccess: input.enableOnSuccess === true }),
    }
  );
  return readJson<{ compileTurnId: string }>(res, "compile automation");
}

/**
 * Rewrite standing instructions from a steering message, then recompile.
 *
 * NOT wired to any screen. The compile screen has exactly one editable surface
 * (the instructions field) and the run screen has none, so nothing in the
 * product turns prose into an instruction rewrite any more. This stays as the
 * typed accessor for the live `POST /centraid/_automations/revise` endpoint —
 * the endpoint and its gateway tests are unchanged, and retiring the wire
 * surface is a protocol decision, not a UI one.
 */
export async function reviseAutomation(input: {
  automationId: string;
  message: string;
}): Promise<{ compileTurnId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/revise?ref=${enc(input.automationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ message: input.message }),
    }
  );
  return readJson<{ compileTurnId: string }>(res, "revise automation");
}

/** The compiled plan the headless compiler wrote for this automation — the
 *  deterministic `automation.json` + `handler.js` that actually run. Either
 *  field is null before a successful first compile. */
export async function readAutomationSource(
  automationId: string
): Promise<{ manifest: string | null; handler: string | null }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/source?ref=${enc(automationId)}`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  return readJson<{ manifest: string | null; handler: string | null }>(
    res,
    "read automation source"
  );
}
