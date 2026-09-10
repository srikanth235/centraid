/**
 * THE THIRD ANSWER, ON THE HANDLER SIDE (#1014, B2/B3/B20/R10).
 *
 * Every recognition recipe walks its library behind an ordered cursor and had
 * exactly two answers for a row: DERIVED (stamp it, move on) and SKIPPED
 * (nothing to do, move on). A row it could neither derive nor skip — a
 * detector that threw, a preview that never landed, a delegate that was never
 * wired — threw or parked, and because the walk is ordered every later row
 * waited behind it on every later tick, forever.
 *
 * This is the third answer. A failure is COUNTED against `(capability,
 * target)` in the vault. Under the cap the walk parks on it exactly as it
 * parks on an unready preview, so a transient error costs a tick and nothing
 * more. At the cap the target is DECLINED and the walk advances past it, with
 * the count and the last error on the register `enrichment-health` reads.
 */

/**
 * Ticks an asset may be "not ready" before the walk gives up on it. Far above
 * the failure cap on purpose: a preview rung genuinely takes minutes to land,
 * and at a five-minute recipe cadence this is an hour of patience. A crashing
 * detector gets three tries; a slow codec gets twelve.
 */
export const NOT_READY_MAX_TICKS = 12;

/**
 * Count one failure and say whether the walk should now move past the target.
 * Best-effort by construction: if the record itself fails, the caller parks
 * exactly as it did before, which is the behaviour this replaces — never worse.
 */
export async function recordTargetFailure(ctx, input) {
  try {
    const result = await ctx.vault.invoke({
      command: "enrich.record_target_failure",
      input: {
        capability: input.capability,
        target_type: input.targetType,
        target_id: input.targetId,
        ...(input.error === undefined
          ? {}
          : { error: String(input.error).slice(0, 2000) }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.permanent === undefined
          ? {}
          : { permanent: input.permanent }),
        ...(input.maxFailures === undefined
          ? {}
          : { max_failures: input.maxFailures }),
      },
    });
    const output = result?.output ?? result;
    return {
      failures: Number(output?.failures ?? 0),
      declined: output?.declined === true,
    };
  } catch {
    return { failures: 0, declined: false };
  }
}

/** The message a caught value carries, bounded for a stored column. */
export function failureMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 500);
}
