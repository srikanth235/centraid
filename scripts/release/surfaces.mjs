export const RELEASE_SURFACES = [
  {
    id: "desktop",
    title: "Desktop (Electron)",
    cadence: "tag",
    defaultOnProductTag: true,
    workflow: "lane-release-desktop.yml",
    tagPattern: "v*",
    secretGroups: ["desktop-apple", "desktop-azure"],
    notes:
      "Installers attach to GH Release when signing enrolled. Retry tags: desktop-v*, desktop-<os>-v*.",
  },
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
    id: "gateway-npm",
    title: "Gateway npm graph",
    cadence: "tag",
    defaultOnProductTag: true,
    workflow: "lane-release-gateway-npm.yml",
    tagPattern: "v*",
    secretGroups: ["gateway-npm"],
    notes: "Multi-OS tunnel NAPI (#511). Dry-run without NPM_TOKEN.",
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
  {
    id: "web",
    title: "Web PWA (app.centraid.dev)",
    cadence: "continuous",
    defaultOnProductTag: false,
    workflow: "web.yml",
    secretGroups: ["web"],
    notes: "Path-filtered main deploy — not part of v* publish checklist.",
  },
  {
    id: "docs",
    title: "Docs / marketing site",
    cadence: "continuous",
    defaultOnProductTag: false,
    workflow: "ci.yml",
    secretGroups: ["web"],
    notes:
      "Continuous on docs paths — the `docs` lane of ci.yml; Cloudflare Git integration deploys.",
  },
  {
    id: "oauth-worker",
    title: "Centraid Assist OAuth Worker",
    cadence: "continuous",
    defaultOnProductTag: false,
    workflow: "oauth-worker.yml",
    secretGroups: ["web"],
    notes:
      "Protected main deploy only after Google production/verification and Cloudflare edge evidence gates pass.",
  },
  {
    id: "companion",
    title: "Browser companion extension",
    cadence: "sideline",
    defaultOnProductTag: false,
    workflow: "lane-release-companion.yml",
    tagPattern: "companion-v* | product v* (prefer product stamp)",
    secretGroups: [],
    notes:
      "Stamps the same product version. Prefer packaging from product tag; companion-v* is rebuild-only (surface retry), not a second product line.",
  },
];

export function defaultShipSurfaceIds() {
  return RELEASE_SURFACES.filter((s) => s.defaultOnProductTag).map((s) => s.id);
}

export function resolveShipSurfaces(ids) {
  const byId = new Map(RELEASE_SURFACES.map((s) => [s.id, s]));
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
