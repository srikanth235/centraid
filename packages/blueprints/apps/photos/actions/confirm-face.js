/**
 * Confirm one face proposal as a person (issue #299 phase 3) — the owner
 * half of the propose-and-confirm loop `media_face_region` always carried.
 * Risk low: it curates DERIVED data, same class as captioning.
 *
 * @type {import('@centraid/openclaw-plugin').ActionHandler}
 */
export default async ({ body, ctx }) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.confirm_face',
      input: {
        region_id: String(body?.region_id ?? ''),
        party_id: String(body?.party_id ?? ''),
      },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
