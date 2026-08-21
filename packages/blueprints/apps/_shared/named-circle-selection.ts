export type ShareCapability = "read" | "read+write";

export interface ManualSelectionResult {
  /** A manual roster/capability edit always becomes an implicit audience. */
  circleId: "";
  selections: Record<string, ShareCapability>;
}

/** Apply one individual row edit and deliberately detach it from any named
 * circle. Re-selecting the named circle is the only way to send circleId. */
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
