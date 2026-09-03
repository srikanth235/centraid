import type { LandmarkBuilder } from "../core/types.js";
import { LANDMARKS_CORE } from "./landmarks-core.js";
import { LANDMARKS_DATA } from "./landmarks-data.js";
import { LANDMARKS_EDGE } from "./landmarks-edge.js";

export const LANDMARKS: Record<string, LandmarkBuilder> = {
  ...LANDMARKS_CORE,
  ...LANDMARKS_DATA,
  ...LANDMARKS_EDGE,
};
