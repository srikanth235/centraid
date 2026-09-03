export const INLINE_APP_DISABLED_SEATS: Readonly<
  Record<string, readonly string[]>
> = {
  locker: ["viewer"],
};

export function isDisabledOnSeat(appId: string, seat: string): boolean {
  return (INLINE_APP_DISABLED_SEATS[appId] ?? []).includes(seat);
}

export const INLINE_APP_SEAT_REFUSALS: Readonly<
  Record<string, { title: string; body: string; wayIn: string }>
> = {
  locker: {
    title: "Locker does not open on a shared browser",
    body: "A shared browser cannot hold the user-presence boundary this app depends on, so Locker refuses the seat outright.",
    wayIn: "Use the desktop app beside your gateway, or your phone.",
  },
};
