export const leakBudgets = {
  warmupCycles: 3,

  measuredCycles: 12,

  maxIntervalGrowth: 0,
  maxEventSourceGrowth: 0,
  maxObserverGrowth: 0,

  maxListenerGrowth: 2,

  maxDomNodeGrowth: 2,

  maxRetainedNodeGrowth: 6,

  maxHeapGrowthRatio: 0.35,

  minMountedSubtreeNodes: 5,

  perApp: {
    Photos: {
      maxListenerGrowth: 0,
      maxRetainedNodeGrowth: 6,
    },
  },
} as const;

export type LeakCeilings = Record<
  Exclude<
    keyof typeof leakBudgets,
    "warmupCycles" | "measuredCycles" | "perApp"
  >,
  number
>;

export function budgetsForApp(appName: string): LeakCeilings {
  const overrides: Partial<LeakCeilings> =
    (leakBudgets.perApp as Record<string, Partial<LeakCeilings>>)[appName] ??
    {};
  return {
    maxIntervalGrowth: leakBudgets.maxIntervalGrowth,
    maxEventSourceGrowth: leakBudgets.maxEventSourceGrowth,
    maxObserverGrowth: leakBudgets.maxObserverGrowth,
    maxListenerGrowth: leakBudgets.maxListenerGrowth,
    maxDomNodeGrowth: leakBudgets.maxDomNodeGrowth,
    maxRetainedNodeGrowth: leakBudgets.maxRetainedNodeGrowth,
    maxHeapGrowthRatio: leakBudgets.maxHeapGrowthRatio,
    minMountedSubtreeNodes: leakBudgets.minMountedSubtreeNodes,
    ...overrides,
  };
}
