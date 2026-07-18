/**
 * Confirm one face proposal as a person (issue #299 phase 3) — the owner
 * half of the propose-and-confirm loop `media_face_region` always carried.
 * Risk low: it curates DERIVED data, same class as captioning.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }: HandlerArgs) => {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.confirm_face',
      input: {
        region_id: String(input.region_id ?? ''),
        party_id: String(input.party_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { status: 200, body: { status: 'denied', reason: e.message, code: e.code } };
  }
};
