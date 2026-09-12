import { actionInput, runVaultAction } from "../../_shared/action-kit.ts";

/**
 * Empty the whole document trash through `core.empty_document_trash` (#1015,
 * D1). Irreversible, and it takes no id: every document already in the trash
 * has its grace window collapsed, and the gateway's next lifecycle sweep
 * destroys each one with its rent checks, authority revocations and
 * provenance receipts intact. A document that was restored is not in the
 * trash and is not touched.
 */
export default async function emptyTrash({ body, ctx }: HandlerArgs) {
  actionInput(body);
  return runVaultAction(ctx, {
    command: "core.empty_document_trash",
    input: {},
  });
}
