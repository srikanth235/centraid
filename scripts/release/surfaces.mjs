/**
 * Release surface catalog (issue #512).
 * One product version stamps the monorepo; ship selection is per surface.
 */

/** @typedef {'tag' | 'store' | 'continuous' | 'sideline'} SurfaceCadence */

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
    id: 'desktop',
    title: 'Desktop (Electron)',
    cadence: 'tag',
    defaultOnProductTag: true,
    workflow: 'release-desktop.yml',
    tagPattern: 'v*',
    secretGroups: ['desktop-apple', 'desktop-azure'],
    notes:
      'Installers attach to GH Release when signing enrolled. Retry tags: desktop-v*, desktop-<os>-v*.',
  },
  {
    id: 'gateway-image',
    title: 'Gateway container (GHCR)',
    cadence: 'tag',
    defaultOnProductTag: true,
    workflow: 'release-gateway-image.yml',
    tagPattern: 'v*',
    secretGroups: ['gateway-image'],
    notes: 'latest tag only for non-beta (D5).',
  },
  {
    id: 'gateway-npm',
    title: 'Gateway npm graph',
    cadence: 'tag',
    defaultOnProductTag: true,
    workflow: 'npm-gateway-publish.yml',
    tagPattern: 'v*',
    secretGroups: ['gateway-npm'],
    notes: 'Multi-OS tunnel NAPI (#511). Dry-run without NPM_TOKEN.',
  },
  {
    id: 'mobile',
    title: 'Mobile (iOS / Android stores)',
    cadence: 'store',
    defaultOnProductTag: false,
    workflow: 'release-mobile.yml',
    secretGroups: ['mobile'],
    notes: 'workflow_dispatch only (J7). Same product version stamp; ship is opt-in.',
  },
  {
    id: 'web',
    title: 'Web PWA (app.centraid.dev)',
    cadence: 'continuous',
    defaultOnProductTag: false,
    workflow: 'web.yml',
    secretGroups: ['web'],
    notes: 'Path-filtered main deploy — not part of v* publish checklist.',
  },
  {
    id: 'docs',
    title: 'Docs / marketing site',
    cadence: 'continuous',
    defaultOnProductTag: false,
    workflow: 'docs.yml',
    secretGroups: ['web'],
    notes: 'Continuous on docs paths.',
  },
  {
    id: 'companion',
    title: 'Browser companion extension',
    cadence: 'sideline',
    defaultOnProductTag: false,
    workflow: 'extension-release.yml',
    tagPattern: 'companion-v* | product v* (prefer product stamp)',
    secretGroups: [],
    notes:
      'Stamps the same product version. Prefer packaging from product tag; companion-v* is rebuild-only (surface retry), not a second product line.',
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
        error: `Unknown surface "${id}". Known: ${RELEASE_SURFACES.map((x) => x.id).join(', ')}`,
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
      'One monorepo product semver. Surfaces may skip ship, never diverge stamps in git.',
    protocolRule: 'Runtime connect compares protocolVersion only (issue #512).',
    buildNumberRule:
      'Stores: major*1e6+minor*1e3+patch from product version; never hand-set; resubmit = new patch.',
    defaultShip: defaultShipSurfaceIds(),
    shipThisCycle: shipIds,
    surfaces: RELEASE_SURFACES.map((s) => ({
      ...s,
      inDefaultShip: s.defaultOnProductTag,
      inThisShip: shipSet.has(s.id),
    })),
  };
}
