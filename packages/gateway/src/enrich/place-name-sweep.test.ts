// The place-name spec on the shared capability sweep — behaviour, not
// mechanism. The claims under test are the ones an owner would recognise: a
// coordinate becomes somewhere with a name, a name they typed themselves is
// never overwritten, a coordinate the gazetteer does not recognise is left
// alone rather than given a made-up label, a repeated pass changes nothing,
// and a vault whose owner said "off" produces no traffic at all.
//
// Every case runs against the FAKE ENRICHMENT SERVICE over a real socket, for
// the same reason the other sweep suites do: the enrichment service is a wire
// contract, and a stubbed client would test the wrong thing.

import { describe, expect, test } from "vitest";

import {
  bootstrapVault,
  createGateway,
  nowIso,
  openVaultDb,
  registerEnrichCommands,
  registerMediaCommands,
  uuidv7,
} from "@centraid/vault";
import type { Credential, VaultDb } from "@centraid/vault";

import { runCapabilitySweep } from "./capability-sweep.js";
import { startFakeEnrichService } from "./fake-enrich-service.test-fixtures.js";
import type {
  FakeCapabilityBehaviour,
  FakeEnrichService,
} from "./fake-enrich-service.test-fixtures.js";
import { PLACE_NAME_SWEEP_SPEC } from "./place-name-sweep.js";

interface Fixture {
  db: VaultDb;
  owner: Credential;
  gw: ReturnType<typeof createGateway>;
  /** Insert a place row directly — there is no command that mints one. */
  addPlace: (
    name: string | null,
    lat: number | null,
    lng: number | null
  ) => string;
  nameOf: (placeId: string) => string | null;
}

function fixture(tier: "off" | "device" | "gateway" = "gateway"): Fixture {
  const db = openVaultDb();
  const boot = bootstrapVault(db, { ownerName: "Priya" });
  const gw = createGateway(db);
  registerMediaCommands(gw);
  registerEnrichCommands(gw);
  const owner: Credential = {
    kind: "device",
    deviceId: boot.deviceId,
    deviceKey: boot.deviceKey,
  };
  db.vault
    .prepare("UPDATE enrich_policy SET tier = ? WHERE domain = 'photos'")
    .run(tier);

  return {
    db,
    gw,
    owner,
    addPlace: (name, lat, lng) => {
      const placeId = uuidv7();
      db.vault
        .prepare(
          `INSERT INTO core_place
             (place_id, name, kind, geo_lat, geo_lng, created_at)
           VALUES (?, ?, NULL, ?, ?, ?)`
        )
        .run(placeId, name, lat, lng, nowIso());
      return placeId;
    },
    nameOf: (placeId) =>
      (
        db.vault
          .prepare("SELECT name FROM core_place WHERE place_id = ?")
          .get(placeId) as { name: string | null }
      ).name,
  };
}

/** A gazetteer that answers `name` for everything it is handed. */
function gazetteer(
  name: string | null,
  model = "fake-gazetteer@1"
): Promise<FakeEnrichService> {
  const behaviour: FakeCapabilityBehaviour = {
    model,
    result: () => ({ name, region: "California", confidence: 0.8 }),
  };
  return startFakeEnrichService({ capabilities: { "place-name": behaviour } });
}

async function sweep(fx: Fixture, service: FakeEnrichService) {
  return runCapabilitySweep(fx.db, PLACE_NAME_SWEEP_SPEC, {
    config: service.config,
  });
}

describe("place-name sweep", () => {
  test("a coordinate-labelled place becomes somewhere with a name", async () => {
    const fx = fixture();
    // Exactly the label `findOrCreatePlaceTx` mints.
    const placeId = fx.addPlace("39.0021, -120.1131", 39.0021, -120.1131);
    const service = await gazetteer("Emerald Bay");
    try {
      const result = await sweep(fx, service);
      expect(result.derived).toBe(1);
      expect(fx.nameOf(placeId)).toBe("Emerald Bay");
    } finally {
      await service.close();
    }
  });

  // The one that matters most. A gazetteer renaming somebody's "Home" to
  // "Palo Alto" is a model overwriting a human fact, and it is the failure
  // this whole spec is shaped to prevent.
  test("a name the member typed is never overwritten", async () => {
    const fx = fixture();
    const placeId = fx.addPlace("Home", 37.4419, -122.143);
    const service = await gazetteer("Palo Alto");
    try {
      const result = await sweep(fx, service);
      // Not selected at all — it never even reached the service.
      expect(result.scanned).toBe(0);
      expect(service.calls).toHaveLength(0);
      expect(fx.nameOf(placeId)).toBe("Home");
    } finally {
      await service.close();
    }
  });

  test("a coordinate the gazetteer does not recognise keeps its label", async () => {
    const fx = fixture();
    // Middle of the Pacific: an honest index has nothing to say.
    const placeId = fx.addPlace("-30.0000, -140.0000", -30, -140);
    const service = await gazetteer(null);
    try {
      await sweep(fx, service);
      // No invented "Unknown", no empty string — the coordinate stands.
      expect(fx.nameOf(placeId)).toBe("-30.0000, -140.0000");
    } finally {
      await service.close();
    }
  });

  test("an unrecognised coordinate is not asked about twice", async () => {
    const fx = fixture();
    fx.addPlace("-30.0000, -140.0000", -30, -140);
    const service = await gazetteer(null);
    try {
      await sweep(fx, service);
      const second = await sweep(fx, service);
      // The stamp landed even though no name did, so the backfill has moved
      // on. Without it this row would be re-sent every pass forever.
      expect(second.scanned).toBe(0);
    } finally {
      await service.close();
    }
  });

  test("a second pass over a named place does nothing", async () => {
    const fx = fixture();
    fx.addPlace("39.0021, -120.1131", 39.0021, -120.1131);
    const service = await gazetteer("Emerald Bay");
    try {
      await sweep(fx, service);
      const second = await sweep(fx, service);
      expect(second.derived).toBe(0);
      expect(second.scanned).toBe(0);
    } finally {
      await service.close();
    }
  });

  test("a place with no coordinates is not a geocoding target", async () => {
    const fx = fixture();
    // A room. Nothing to reverse-geocode, and no label to replace.
    const placeId = fx.addPlace("Kitchen", null, null);
    const service = await gazetteer("Somewhere");
    try {
      const result = await sweep(fx, service);
      expect(result.scanned).toBe(0);
      expect(fx.nameOf(placeId)).toBe("Kitchen");
    } finally {
      await service.close();
    }
  });

  // `off` must not be observable as traffic — consent is read before the
  // service is probed, so this vault makes no request of any kind.
  test("an owner who said off produces no request at all", async () => {
    const fx = fixture("off");
    const placeId = fx.addPlace("39.0021, -120.1131", 39.0021, -120.1131);
    const service = await gazetteer("Emerald Bay");
    try {
      await sweep(fx, service);
      expect(service.calls).toHaveLength(0);
      expect(service.probes()).toBe(0);
      expect(fx.nameOf(placeId)).toBe("39.0021, -120.1131");
    } finally {
      await service.close();
    }
  });

  test("the device tier is not the gateway tier either", async () => {
    const fx = fixture("device");
    const service = await gazetteer("Emerald Bay");
    try {
      fx.addPlace("39.0021, -120.1131", 39.0021, -120.1131);
      await sweep(fx, service);
      expect(service.calls).toHaveLength(0);
    } finally {
      await service.close();
    }
  });

  test("a better gazetteer supersedes the older one's answers", async () => {
    const fx = fixture();
    const placeId = fx.addPlace("39.0021, -120.1131", 39.0021, -120.1131);
    const first = await gazetteer("Lake Tahoe", "fake-gazetteer@1");
    try {
      await sweep(fx, first);
      expect(fx.nameOf(placeId)).toBe("Lake Tahoe");
    } finally {
      await first.close();
    }
    // A newer version of the SAME model family. The row it already named is
    // no longer a coordinate label, so it is out of the backlog by name shape
    // — the supersede path only reaches rows still wearing one.
    const second = await gazetteer("Emerald Bay", "fake-gazetteer@2");
    try {
      const again = await sweep(fx, second);
      expect(again.scanned).toBe(0);
      expect(fx.nameOf(placeId)).toBe("Lake Tahoe");
    } finally {
      await second.close();
    }
  });

  test("only the coordinate-labelled places in a mixed vault are touched", async () => {
    const fx = fixture();
    const labelled = fx.addPlace("39.0021, -120.1131", 39.0021, -120.1131);
    const named = fx.addPlace("Home", 37.4419, -122.143);
    const roomOnly = fx.addPlace("Kitchen", null, null);
    const service = await gazetteer("Emerald Bay");
    try {
      const result = await sweep(fx, service);
      expect(result.scanned).toBe(1);
      expect(fx.nameOf(labelled)).toBe("Emerald Bay");
      expect(fx.nameOf(named)).toBe("Home");
      expect(fx.nameOf(roomOnly)).toBe("Kitchen");
    } finally {
      await service.close();
    }
  });
});
