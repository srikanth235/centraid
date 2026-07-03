/**
 * Log a vital through the vault's typed command. The outcome is passed
 * through verbatim — `executed`, `parked` (awaiting owner confirmation),
 * `denied`, or `failed` (a precondition such as the positive-value check) —
 * so the UI can narrate what the consent plane decided.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  const input = body ?? {};
  // Backdating: health.log_vital already accepts observed_at — pass it
  // through only when it parses as a real instant, normalized to ISO.
  const observedAt = input.observed_at ? new Date(String(input.observed_at)) : null;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'health.log_vital',
      input: {
        vital_type: String(input.vital_type ?? ''),
        value_num: Number(input.value_num),
        ...(input.context ? { context: String(input.context) } : {}),
        ...(input.modality ? { modality: String(input.modality) } : {}),
        ...(observedAt && !Number.isNaN(observedAt.getTime())
          ? { observed_at: observedAt.toISOString() }
          : {}),
      },
      purpose: 'dpv:HealthMonitoring',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
