export type ShareCapability = "read" | "read+write";

export interface ManualSelectionResult {
  circleId: "";
  selections: Record<string, ShareCapability>;
}

export function manualShareSelection(
  current: Readonly<Record<string, ShareCapability>>,
  destinationId: string,
  capability?: ShareCapability
): ManualSelectionResult {
  if (capability)
    return {
      circleId: "",
      selections: { ...current, [destinationId]: capability },
    };
  const { [destinationId]: _removed, ...selections } = current;
  return { circleId: "", selections };
}
