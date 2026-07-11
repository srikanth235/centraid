/**
 * Reject one face proposal (issue #299 phase 3): the region row deletes —
 * it is derived, re-derivable data, so rejection is disposal, not history.
 *
 * @type {import('@centraid/app-engine').ActionHandler}
 */
export default async ({ body, ctx }) => {
  try {
    const outcome = await ctx.vault.invoke({
      command: 'media.reject_face',
      input: { region_id: String(body?.region_id ?? '') },
      purpose: 'dpv:ServiceProvision',
    });
    return { status: 200, body: outcome };
  } catch (err) {
    return { status: 200, body: { status: 'denied', reason: err.message, code: err.code } };
  }
};
