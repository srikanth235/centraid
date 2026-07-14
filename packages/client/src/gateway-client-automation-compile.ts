import { auth, authHeaders, doFetch, enc, readJson } from './gateway-client-core.js';

/** Start the hidden compile path; the returned run appears in the automation thread. */
export async function compileAutomation(input: {
  automationId: string;
  enableOnSuccess?: boolean;
}): Promise<{ runId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/compile?ref=${enc(input.automationId)}`,
    {
      method: 'POST',
      headers: authHeaders(token, 'application/json'),
      body: JSON.stringify({ enableOnSuccess: input.enableOnSuccess === true }),
    },
  );
  return readJson<{ runId: string }>(res, 'compile automation');
}

/** The compiled plan the headless compiler wrote for this automation — the
 *  deterministic `automation.json` + `handler.js` that actually run. Either
 *  field is null before a successful first compile. */
export async function readAutomationSource(
  automationId: string,
): Promise<{ manifest: string | null; handler: string | null }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations/source?ref=${enc(automationId)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<{ manifest: string | null; handler: string | null }>(
    res,
    'read automation source',
  );
}
