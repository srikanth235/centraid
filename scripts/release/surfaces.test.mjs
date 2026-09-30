import assert from "node:assert/strict";
import test from "node:test";

import {
  RELEASE_SURFACES,
  buildSurfaceMatrix,
  defaultShipSurfaceIds,
  resolveShipSurfaces,
} from "./surfaces.mjs";

test("default ship is tag surfaces only (not mobile)", () => {
  const ids = defaultShipSurfaceIds();
  assert.ok(ids.includes("gateway-image"));
  assert.ok(ids.includes("prebuilt-core"));
  assert.ok(!ids.includes("mobile"));
});

test("resolveShipSurfaces rejects unknown ids", () => {
  const bad = resolveShipSurfaces(["gateway-image", "nope"]);
  assert.equal(bad.ok, false);
  // `desktop` was a surface until the #1029 scope amendment of 2026-09-21 and
  // is now exactly as unknown as "nope" — which is the property this asserts.
  assert.equal(resolveShipSurfaces(["desktop"]).ok, false);
  const good = resolveShipSurfaces(["gateway-image", "mobile"]);
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.surfaces.length, 2);
});

test("buildSurfaceMatrix marks ship set", () => {
  const m = buildSurfaceMatrix({ shipIds: ["mobile"] });
  assert.deepEqual(m.shipThisCycle, ["mobile"]);
  const mobile = m.surfaces.find((s) => s.id === "mobile");
  assert.equal(mobile?.inThisShip, true);
  assert.equal(
    m.surfaces.find((s) => s.id === "gateway-image")?.inThisShip,
    false
  );
});

test("catalog ids unique", () => {
  const ids = RELEASE_SURFACES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every surface names a workflow file that exists on disk", async () => {
  // #557 — the catalog named five workflows that had been renamed, and nothing
  // noticed: it is documentation-as-data with no link to the tree it describes.
  const { existsSync } = await import("node:fs");
  const missing = RELEASE_SURFACES.filter(
    (surface) => !existsSync(`.github/workflows/${surface.workflow}`)
  ).map((surface) => `${surface.id} → ${surface.workflow}`);
  assert.deepEqual(missing, []);
});
