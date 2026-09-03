export default async function lockerAuth({
  input,
  ctx,
}: {
  input?: Record<string, unknown>;
  ctx: HandlerCtx;
}) {
  const operation = String(input?.operation ?? "status");
  const request: Record<string, unknown> = { operation };
  for (const key of [
    "sessionToken",
    "secret",
    "credentialId",
    "itemId",
    "label",
  ]) {
    if (input?.[key] != null) request[key] = String(input[key]);
  }
  try {
    return await ctx.vault.authenticate(request);
  } catch (caughtError) {
    const error = caughtError as { code?: string; message?: string };
    return {
      ok: false,
      configured: false,
      authenticated: false,
      code: error.code ?? "AUTH_UNAVAILABLE",
      message: error.message ?? "Locker authentication is unavailable.",
    };
  }
}
