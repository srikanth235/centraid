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
