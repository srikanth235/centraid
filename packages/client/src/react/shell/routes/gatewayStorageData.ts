import { getStorageUsage } from "../../../gateway-client.js";
import type { UsageInput } from "../../../storage-metrics.js";
import { aggregateUsage } from "../../screens/backupMetrics.js";

export async function loadStorageUsageAggregate(): Promise<UsageInput | null> {
  const connections = await getStorageUsage();
  return aggregateUsage(connections);
}
