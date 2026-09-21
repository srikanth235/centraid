/**
 * Release surface catalog (issue #512).
 *
 * Three surfaces. The desktop (Electron) and the browser companion were struck
 * from v0 by the scope amendment of 2026-09-21 on issue #1029, and their
 * workflows were deleted with them; a catalog row naming a workflow that is not
 * on disk is what `surfaces.test.mjs` refuses.
 * One product version stamps the monorepo; ship selection is per surface.
 */

/** @typedef {'tag' | 'store' | 'sideline'} SurfaceCadence */

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   cadence: SurfaceCadence;
 *   defaultOnProductTag: boolean;
 *   workflow?: string;
 *   tagPattern?: string;
 *   secretGroups: string[];
 *   notes: string;
 * }} ReleaseSurface
 */

/** @type {ReleaseSurface[]} */
export const RELEASE_SURFACES = [
  {
    id: "gateway-image",
    title: "Gateway container (GHCR)",
    cadence: "tag",
    defaultOnProductTag: true,
    workflow: "lane-release-gateway-image.yml",
    tagPattern: "v*",
    secretGroups: ["gateway-image"],
    notes: "latest tag only for non-beta (D5).",
  },
  {
    id: "prebuilt-core",
    title: "Prebuilt core (binaries, Android ABIs, iOS XCFramework)",
    cadence: "tag",
    defaultOnProductTag: true,
    workflow: "lane-prebuilt-core.yml",
    tagPattern: "v*",
    secretGroups: [],
    notes:
      "Rides `all`: it submits nothing to anybody, and a release whose core was never built for a required triple is a partial release (D-1020-G2).",
  },
  {
    id: "mobile",
    title: "Mobile (iOS / Android stores)",
    cadence: "store",
    defaultOnProductTag: false,
    workflow: "lane-release-mobile.yml",
    secretGroups: ["mobile"],
    notes:
      "release.yml dispatch with surfaces: mobile only (J7) — never implied by a tag. Same product version stamp; ship is opt-in.",
  },
];

/**
 * @returns {string[]} Surface ids that ship by default on a product tag.
 */
export function defaultShipSurfaceIds() {
  return RELEASE_SURFACES.filter((s) => s.defaultOnProductTag).map((s) => s.id);
}

/**
 * @param {string[]} ids Surface ids to resolve from the catalog.
 * @returns {{ ok: true; surfaces: ReleaseSurface[] } | { ok: false; error: string }} Resolved surfaces or error.
 */
export function resolveShipSurfaces(ids) {
  const byId = new Map(RELEASE_SURFACES.map((s) => [s.id, s]));
  /** @type {ReleaseSurface[]} */
  const surfaces = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (!s) {
      return {
        ok: false,
        error: `Unknown surface "${id}". Known: ${RELEASE_SURFACES.map((x) => x.id).join(", ")}`,
      };
    }
    surfaces.push(s);
  }
  return { ok: true, surfaces };
}

/**
 * Human + machine matrix for prepare/status.
 * @param {{ shipIds?: string[] }} [opts] Optional ship-set override (defaults to tag defaults).
 * @returns {{
 *   productVersionRule: string;
 *   protocolRule: string;
 *   buildNumberRule: string;
 *   defaultShip: string[];
 *   shipThisCycle: string[];
 *   surfaces: Array<ReleaseSurface & { inDefaultShip: boolean; inThisShip: boolean }>;
 * }} Matrix object for CLI/prepare JSON.
 */
export function buildSurfaceMatrix(opts = {}) {
  const shipIds = opts.shipIds ?? defaultShipSurfaceIds();
  const shipSet = new Set(shipIds);
  return {
    productVersionRule:
      "One monorepo product semver. Surfaces may skip ship, never diverge stamps in git.",
    protocolRule: "Runtime connect compares protocolVersion only (issue #512).",
    buildNumberRule:
      "Stores: major*1e6+minor*1e3+patch from product version; never hand-set; resubmit = new patch.",
    defaultShip: defaultShipSurfaceIds(),
    shipThisCycle: shipIds,
    surfaces: RELEASE_SURFACES.map((s) => ({
      ...s,
      inDefaultShip: s.defaultOnProductTag,
      inThisShip: shipSet.has(s.id),
    })),
  };
}
