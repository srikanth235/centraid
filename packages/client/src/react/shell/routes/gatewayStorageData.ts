import { getStorageUsage } from '../../../gateway-client.js';
import { aggregateUsage } from '../../screens/backupMetrics.js';
import type { UsageInput } from '../../../storage-metrics.js';

// Backups Cost-metric data layer (issue #436 §6/§7) — the ONE aggregate the
// five-metric Cost readout needs. Sums every home connection's provider-
// reported per-store usage into the shape `deriveStorageMetrics` consumes; the
// old per-connection quota bars + drift lines (store-class vocabulary) are gone
// with the StorageCard they used to feed. `null` before the first poll or when
// the provider doesn't meter.
export async function loadStorageUsageAggregate(): Promise<UsageInput | null> {
  const connections = await getStorageUsage();
  return aggregateUsage(connections);
}
