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
