// The seven app stacks, evaluated on the first navigation into each (#922 E8).
//
// `navigators.tsx` builds seven `createNativeStackNavigator()`s at module scope
// and names every screen in the app, so a cold launch — which draws Home and no
// stack at all — paid for all seven. The screens behind them are already
// deferred (`lazy-screens.tsx`); this defers the stacks themselves, and with
// them the whole `navigators.tsx` module graph.
//
// It lives beside `App.tsx` for the reason `lazy-screens.tsx` does: only the
// composition root may name every app (`scripts/check-import-boundaries.ts`).
//
// Every export below is reachable only through a `component=` prop on the root
// navigator; nothing else in this file may reference them, which is what keeps
// the deferral honest.

import { lazyScreen } from "./lazy-screens";

export const AgendaNavigator = lazyScreen<object>(async () => ({
  default: (await import("./navigators")).AgendaNavigator,
}));
export const DocsNavigator = lazyScreen<object>(async () => ({
  default: (await import("./navigators")).DocsNavigator,
}));
export const LockerNavigator = lazyScreen<object>(async () => ({
  default: (await import("./navigators")).LockerNavigator,
}));
export const PeopleNavigator = lazyScreen<object>(async () => ({
  default: (await import("./navigators")).PeopleNavigator,
}));
export const PhotosNavigator = lazyScreen<object>(async () => ({
  default: (await import("./navigators")).PhotosNavigator,
}));
export const SettingsNavigator = lazyScreen<object>(async () => ({
  default: (await import("./navigators")).SettingsNavigator,
}));
export const TallyNavigator = lazyScreen<object>(async () => ({
  default: (await import("./navigators")).TallyNavigator,
}));
