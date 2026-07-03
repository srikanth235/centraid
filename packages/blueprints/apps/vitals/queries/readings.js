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

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(subjectType, attachments, contentById) {
  const bySubject = new Map();
  for (const a of attachments) {
    if (a.subject_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.subject_id)) bySubject.set(a.subject_id, []);
    bySubject.get(a.subject_id).push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? 'application/octet-stream',
      title: content?.title ?? null,
      content_uri: content?.content_uri ?? '',
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

export default async ({ query, ctx }) => {
  const purpose = 'dpv:HealthMonitoring';
  // The cap is a projection courtesy, not a secret: the caller can widen it
  // (charts want a year of history), and the result says when rows were cut.
  const limit = Math.max(1, Math.min(2000, Math.trunc(Number(query?.limit)) || 200));
  try {
    const [vitals, observations, contents, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'health.vital', purpose }),
      ctx.vault.read({
        entity: 'core.observation',
        where: [{ column: 'status', op: 'ne', value: 'entered-in-error' }],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'health.vital' }],
        purpose,
      }),
    ]);
    const byObservation = new Map((observations.rows ?? []).map((o) => [o.observation_id, o]));
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByVital = attachmentsBySubject('health.vital', attachments.rows ?? [], contentById);
    const joined = (vitals.rows ?? [])
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
          attachments: attByVital.get(v.vital_id) ?? [],
        };
      })
      .filter(Boolean)
      .toSorted((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)));
    const readings = joined.slice(0, limit);
    return { readings, total: joined.length, truncated: joined.length > limit };
  } catch (err) {
    return {
      readings: [],
      total: 0,
      truncated: false,
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
