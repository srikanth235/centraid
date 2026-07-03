/**
 * Void a reading through health.void_vital — the observation is marked
 * entered-in-error (FHIR-terminal), never deleted, so the row survives as
 * provenance while every readings query stops seeing it. The command is
 * risk medium and apps run at a low ceiling, so the usual outcome here is
 * `parked`: the owner approves the removal in vault settings.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  try {
    const outcome = await ctx.vault.invoke({
      command: 'health.void_vital',
      input: {
        observation_id: String(input.observation_id ?? ''),
        ...(input.reason ? { reason: String(input.reason) } : {}),
      },
      purpose: 'dpv:HealthMonitoring',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
