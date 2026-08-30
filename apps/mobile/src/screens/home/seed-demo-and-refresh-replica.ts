import type { RebootstrapOptions } from "../../lib/replica/native-session";

/**
 * Home's "Fill it with sample content" path after pairing.
 *
 * Demo writes are absent from the change feed (they must not wake automations),
 * so the phone has to rebuild the replica before Home re-reads tiles. A fresh
 * pairing can still have its first bootstrap settling; one bounded retry lets
 * that walk finish without putting the synchronization budget on Maestro.
 */
export interface DemoReplica {
  refresh?: () => Promise<unknown>;
  session?: {
    rebootstrap?: (options?: RebootstrapOptions) => Promise<void>;
  };
}

export interface SeedDemoAndRefreshReplica {
  requireGatewayBase: () => Promise<string>;
  fetchJson: (
    url: string,
    init: { headers: HeadersInit; method: string }
  ) => Promise<unknown>;
  apiHeaders: () => HeadersInit;
  replica: DemoReplica;
  wait?: (ms: number) => Promise<void>;
}

const RETRY_MS = 500;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function seedDemoAndRefreshReplica(
  args: SeedDemoAndRefreshReplica
): Promise<void> {
  const base = await args.requireGatewayBase();
  await args.fetchJson(`${base}/centraid/_vault/demo`, {
    headers: args.apiHeaders(),
    method: "POST",
  });
  // Reachability can still say offline even though the seed request just
  // proved the tunnel; a failed refresh must not skip the snapshot rebuild.
  await args.replica.refresh?.().catch(() => undefined);
  await args.replica.session?.rebootstrap?.({ force: true });
  await (args.wait ?? delay)(RETRY_MS);
  await args.replica.session?.rebootstrap?.({ force: true });
}
