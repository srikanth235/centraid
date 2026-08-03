// landmarks.js — registry of bespoke per-building geometry, keyed by building id.
// Each lane file owns one group of districts; see KIT_API.md for the archetype contract.
// A building without a landmark falls back to its generic `kind` silhouette in world.js.

import { LANDMARKS_CORE } from "./landmarks-core.js";
import { LANDMARKS_DATA } from "./landmarks-data.js";
import { LANDMARKS_EDGE } from "./landmarks-edge.js";

export const LANDMARKS = {
  ...LANDMARKS_CORE,
  ...LANDMARKS_DATA,
  ...LANDMARKS_EDGE,
};
