// The band's home capsule as a MODEL: the frame's own plate beside an app's
// tabs, never one of them — the way home is the one thing an app may not take
// away (#883). Framework-free so the node-environment tests over every band
// model never pull `react-native` in behind a type; `BandCapsule.tsx` renders.
//
// `BAND_CAPSULE.size` is the only size seat here: the shell's `AppBand.tsx`
// already exports `BAND_CAPSULE_SIZE`, and two seats exporting one identifier
// is what the one-computation tripwire counts.

import { metrics } from "@centraid/design";

export interface BandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
  edge: "leading";
  inTabGroup: false;
}

export const BAND_CAPSULE: BandCapsule = {
  edge: "leading",
  icon: "Home",
  inTabGroup: false,
  label: "Home",
  size: metrics.bandCapsule,
};
