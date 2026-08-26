import { getStorageUsage } from "../../../gateway-client.js";
import type { UsageInput } from "../../../storage-metrics.js";
import { aggregateUsage } from "../../screens/backupMetrics.js";

// Backups Cost-metric data layer (#436 §6/§7) — the ONE aggregate the
// five-metric Cost readout needs. Sums every home connection's provider-
// reported per-store usage into the shape `deriveStorageMetrics` consumes.
// `null` before the first poll or when the provider doesn't meter.
export async function loadStorageUsageAggregate(): Promise<UsageInput | null> {
  const connections = await getStorageUsage();
  return aggregateUsage(connections);
}
