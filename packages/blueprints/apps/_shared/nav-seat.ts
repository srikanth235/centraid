export type NavSeat = "band" | "strip" | "rail";

export function navSeat({
  narrow,
  compact,
}: {
  narrow: boolean;
  compact: boolean;
}): NavSeat {
  if (compact && narrow) return "band";
  if (!compact && !narrow) return "rail";
  return "strip";
}
