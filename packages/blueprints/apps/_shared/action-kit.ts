// A refusal is an outcome, not an error: every path answers 200 because the
// DISPATCH succeeded and the vault's decision is in the body. Pinned by
// `action-kit.test.ts`.

export interface VaultActionRequest {
  command: string;
  input: Record<string, unknown>;
}

/** The dispatcher validated the body against the manifest schema already. */
export function actionInput(body: unknown): Record<string, unknown> {
  return (body ?? {}) as Record<string, unknown>;
}

export function deniedResult(reason: string, code?: string): ActionResult {
  return { status: 200, body: { status: "denied", reason, code } };
}

/** `settle` is not a transaction: one that throws answers as a denial. */
export async function runVaultAction(
  ctx: HandlerCtx,
  request: VaultActionRequest,
  settle?: (outcome: VaultOutcome) => Promise<void>
): Promise<ActionResult> {
  try {
    const outcome = await ctx.vault.invoke({
      command: request.command,
      input: request.input,
    });
    await settle?.(outcome);
    return { status: 200, body: outcome };
  } catch (error) {
    const detail = error as { code?: string; message?: string };
    return {
      status: 200,
      body: { status: "denied", reason: detail.message, code: detail.code },
    };
  }
}
