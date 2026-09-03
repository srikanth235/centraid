import type { DistributionDatum } from "./contracts";

export interface DistributionRow extends DistributionDatum {
  share: number;
}

export const DISTRIBUTION_SHARE_FLOOR = 1;

function weight(datum: DistributionDatum): number {
  const value = datum.weight;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function distributionRows(
  data: readonly DistributionDatum[]
): readonly DistributionRow[] {
  const total = data.reduce((sum, datum) => sum + weight(datum), 0);
  return [...data]
    .sort((left, right) => weight(right) - weight(left))
    .map((datum) => {
      const own = weight(datum);
      if (total <= 0 || own <= 0) return { ...datum, share: 0 };
      return {
        ...datum,
        share: Math.max(
          DISTRIBUTION_SHARE_FLOOR,
          Math.min(100, Math.round((own / total) * 100))
        ),
      };
    });
}
