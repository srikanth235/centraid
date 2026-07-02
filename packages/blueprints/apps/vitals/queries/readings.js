/**
 * The vitals projection: health.vital extension rows joined to the
 * core.observation rows they specialize (extend-don't-fork — the vital IS
 * its observation), newest reading first. Everything comes from the vault —
 * this app holds no rows of its own.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:HealthMonitoring';
  try {
    const [vitals, observations] = await Promise.all([
      ctx.vault.read({ entity: 'health.vital', purpose }),
      ctx.vault.read({
        entity: 'core.observation',
        where: [{ column: 'status', op: 'ne', value: 'entered-in-error' }],
        purpose,
      }),
    ]);
    const byObservation = new Map((observations.rows ?? []).map((o) => [o.observation_id, o]));
    const readings = (vitals.rows ?? [])
      .map((v) => {
        const o = byObservation.get(v.observation_id);
        if (!o) return null;
        return {
          vital_id: v.vital_id,
          observation_id: v.observation_id,
          vital_type: v.vital_type,
          context: v.context,
          loinc_code: v.loinc_code,
          value_num: o.value_num,
          unit: o.unit,
          observed_at: o.observed_at,
          modality: o.modality,
          status: o.status,
        };
      })
      .filter(Boolean)
      .toSorted((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)))
      .slice(0, 200);
    return { readings };
  } catch (err) {
    return { readings: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
