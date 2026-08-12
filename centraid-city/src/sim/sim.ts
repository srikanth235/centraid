// sim.ts — the city's little economy. Fixed 10 Hz logic tick, deterministic-ish PRNG.
// Produces: stats (HUD), rates (particles/sec per flow role), pulses (transient FX 0..1),
// activity (0..1 per district, drives the blinking lights).

import type {
  CityContent,
  ScenarioConfig,
  Sim,
  SimActivity,
  SimEvent,
  SimPulses,
  SimRates,
  SimStats,
} from "../core/types.js";

const TICK = 0.1; // 10 Hz

function mulberry32(seed: number): () => number {
  let a = Math.imul(seed, 1);
  return function rnd() {
    a = Math.imul(a + 0x6d2b79f5, 1);
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES = [
  "request",
  "response",
  "harness",
  "result",
  "tool",
  "toolPass",
  "park",
  "appReq",
  "appWrite",
  "directRead",
  "directResult",
  "wal",
  "ship",
  "backup",
  "blob",
  "blobBackup",
  "automation",
  "automationWrite",
  // --- sync path. None of these involve the harness runtime.
  "replica",
  "replicaDeliver",
  "devicePush",
  "replicaMerge",
];

const DISTRICTS = [
  "clients",
  "gateway",
  "runtime",
  "consent",
  "vault",
  "wal",
  "apps",
  "automation",
  "cas",
  "sync",
  "backup",
];

// Scenario knobs. Anything omitted falls back to the steady baseline.
const SCENARIOS: Record<string, ScenarioConfig> = {
  steady: {},
  "first-run": {
    founding: true,
    turns: 0.3,
    writes: 3.2,
    blobs: 0.2,
    harness: 0.5,
    cronEvery: 60,
  },
  "harness-builds-app": {
    turns: 2.2,
    harness: 2.6,
    appWork: 2.4,
    crane: 1,
    writes: 1.7,
    parkChance: 0.16,
  },
  "photo-flood": { blobs: 6.5, casFill: 1, writes: 1.6, turns: 0.7 },
  "offline-mobile": { offline: true, turns: 1.1 },
  // Two paired devices hammering the direct + sync path with the runtime parked.
  // harnessOff forces every harness-path rate (and the runtime district lights) to zero.
  "multi-device": {
    harnessOff: true,
    turns: 1.5,
    writes: 2.8,
    direct: 2.4,
    sync: 2.6,
    appWork: 1.6,
  },
  "automation-storm": {
    cronEvery: 2.2,
    automation: 4.5,
    writes: 2.1,
    turns: 0.5,
  },
  "consent-parking": {
    parkChance: 0.55,
    turns: 1.4,
    harness: 1.8,
    approveSlow: true,
  },
};

export function createSim(content: Pick<CityContent, "scenarios">): Sim {
  const rnd = mulberry32(0xc17a1d);
  const scenarioIds = (content.scenarios || []).map((s) => s.id);
  const stats: SimStats = {
    turns: 0,
    items: 0,
    wal: 0,
    approvals: 0,
    lag: 0,
    cas: 34,
    cron: 30,
    fps: 60,
  };
  const rates: SimRates = {};
  for (const r of ROLES) rates[r] = 0;
  const activity: SimActivity = {};
  for (const d of DISTRICTS) activity[d] = 0;
  const pulses: SimPulses = {
    crane: 0,
    checkpoint: 0,
    barge: 0,
    cron: 0,
    founding: 0,
    catchup: 0,
  };

  let scenarioId = scenarioIds.includes("steady")
    ? "steady"
    : scenarioIds[0] || "steady";
  let cfg = SCENARIOS.steady;
  let acc = 0;
  let elapsed = 0;
  let scenarioAge = 0;
  let offlinePhase = 0; // 0 idle, 1 drifting, 2 catching up
  let cronTimer = 30;
  let checkpointTimer = 8;
  let bargeTimer = 22;
  const events: SimEvent[] = [];
  let turnsWindow = 0;
  let itemsWindow = 0;
  let walWindow = 0;

  // smoothed display values
  const smooth: Pick<SimStats, "turns" | "items" | "wal"> = {
    turns: 0,
    items: 0,
    wal: 0,
  };

  function setScenario(id: string): void {
    scenarioId = id;
    cfg = SCENARIOS[id] || SCENARIOS.steady;
    scenarioAge = 0;
    offlinePhase = cfg.offline ? 1 : 0;
    if (cfg.founding) {
      pulses.founding = 1;
      stats.cas = 4;
      stats.approvals = 0;
      stats.lag = 0;
    }
    if (!cfg.offline) stats.lag = Math.min(stats.lag, 2);
    if (cfg.cronEvery) cronTimer = Math.min(cronTimer, cfg.cronEvery);
    events.push({ type: "scenario", id });
  }

  function bump(k: string, v: number): void {
    activity[k] = Math.min(1.6, activity[k] + v);
  }

  function logic() {
    const dt = TICK;
    elapsed += dt;
    scenarioAge += dt;

    const kTurn = cfg.turns ?? 1;
    // harnessOff parks the whole harness path: no harness turns, no tool calls, no parking.
    // The direct + sync path is deliberately untouched by it — that is the point.
    const harnessOff = !!cfg.harnessOff;
    const kHarness = harnessOff ? 0 : (cfg.harness ?? 1);
    const kWrite = cfg.writes ?? 1;
    const kBlob = cfg.blobs ?? 1;
    const kAuto = cfg.automation ?? 1;
    const kApp = cfg.appWork ?? 1;
    const kDirect = cfg.direct ?? 1;
    const kSync = cfg.sync ?? 1;

    // --- client requests → gateway
    const reqRate = (5.5 + Math.sin(elapsed * 0.31) * 1.8) * kTurn * kDirect;
    rates.request = reqRate;
    rates.response = reqRate * 0.82;
    bump("clients", reqRate * 0.006);
    bump("gateway", reqRate * 0.008);

    // --- turns / harness runtime
    const turnRate = harnessOff
      ? 0
      : (0.55 + Math.max(0, Math.sin(elapsed * 0.17)) * 0.5) * kTurn;
    turnsWindow += turnRate * dt;
    const itemRate = turnRate * (7 + rnd() * 4);
    itemsWindow += itemRate * dt;
    rates.harness = 2.4 * kHarness + turnRate * 2;
    rates.result = rates.harness * 0.6;
    bump("runtime", rates.harness * 0.01);

    // --- tool calls through the consent gate
    const toolRate = 1.5 * kHarness + turnRate * 1.2;
    const parkChance = cfg.parkChance ?? 0.045;
    rates.tool = toolRate;
    rates.park = toolRate * parkChance;
    rates.toolPass = toolRate * (1 - parkChance);
    bump("consent", toolRate * 0.02);

    // parked approvals accumulate, then drain
    if (stats.approvals < 24 && rnd() < toolRate * parkChance * dt) {
      stats.approvals += 1;
      events.push({ type: "park" });
    }
    // the user works through the queue faster the longer it gets, so it plateaus
    const drain = (cfg.approveSlow ? 0.05 : 0.22) + stats.approvals * 0.012;
    if (stats.approvals > 0 && rnd() < drain) {
      stats.approvals -= 1;
      events.push({ type: "approve" });
    }

    // --- apps quarter
    rates.appReq = 2.6 * kApp;
    rates.appWrite = 1.9 * kApp * kWrite;
    rates.directRead = 1.8 * kTurn * kDirect;
    // Ordinary reads/writes answer straight back out of the vault — no runner in the loop.
    rates.directResult = rates.directRead * 0.9 + rates.appWrite * 0.45;
    bump("apps", rates.appReq * 0.008);

    // --- vault writes → WAL
    const writes =
      (rates.toolPass * 0.7 + rates.appWrite + rates.automationWrite || 0) *
      kWrite;
    rates.wal = 3.2 * kWrite + writes * 0.5;
    const kib = rates.wal * (5 + rnd() * 7);
    walWindow += kib * dt;
    bump("vault", rates.wal * 0.008);
    bump("wal", rates.wal * 0.01);

    checkpointTimer -= dt;
    if (checkpointTimer <= 0) {
      checkpointTimer = 8 + rnd() * 6;
      pulses.checkpoint = 1;
      events.push({ type: "checkpoint" });
    }

    // --- sync harbor + replica island
    // Note: this whole leg is gateway → WAL → harbor → device. The harness runtime has no
    // part in it, so none of these rates read kHarness.
    if (offlinePhase === 1) {
      // Device is away: the harbor keeps queueing, nothing lands on the replica.
      stats.lag += dt * (1.4 + scenarioAge * 0.05);
      rates.ship = 0.4;
      rates.replica = 0;
      rates.replicaDeliver = 0.05;
      rates.devicePush = 0.05;
      rates.replicaMerge = 0;
      if (scenarioAge > 14) {
        offlinePhase = 2;
        scenarioAge = 0;
        pulses.catchup = 1;
        events.push({ type: "reconnect" });
      }
    } else if (offlinePhase === 2) {
      // Reconnect: the backlog floods out to the device and its local edits flood back.
      stats.lag = Math.max(0, stats.lag - dt * 4.5);
      rates.ship = 9;
      rates.replica = 16;
      rates.replicaDeliver = 18;
      rates.devicePush = 12;
      rates.replicaMerge = 8;
      if (stats.lag <= 0.05) {
        offlinePhase = 0;
        events.push({ type: "caughtup" });
      }
    } else {
      stats.lag += (0.6 + rnd() * 0.7 - stats.lag) * 0.08;
      rates.ship = (2.4 + rates.wal * 0.25) * kSync;
      rates.replica = (3.4 + rates.wal * 0.3) * kSync;
      rates.replicaDeliver = (2.8 + rates.wal * 0.28) * kSync;
      rates.devicePush = (1.1 + rates.wal * 0.12) * kSync;
      rates.replicaMerge = rates.devicePush * 0.75;
    }
    rates.backup = 0.9 + rates.wal * 0.06;
    bump(
      "sync",
      (rates.replica + rates.replicaDeliver + rates.devicePush) * 0.006
    );
    bump("backup", rates.backup * 0.02);

    // --- blob CAS
    rates.blob = 1.5 * kBlob;
    rates.blobBackup = 0.7 * kBlob;
    const fill = rates.blob * dt * (cfg.casFill ? 0.55 : 0.06);
    stats.cas = Math.min(99, stats.cas + fill);
    bump("cas", rates.blob * 0.012);

    bargeTimer -= dt;
    if (bargeTimer <= 0 || stats.cas > 92) {
      bargeTimer = cfg.casFill ? 9 : 22 + rnd() * 10;
      pulses.barge = 1;
      stats.cas = Math.max(18, stats.cas - (cfg.casFill ? 12 : 6));
      events.push({ type: "barge" });
    }

    // --- automation yard
    const cronEvery = cfg.cronEvery ?? 30;
    cronTimer -= dt;
    if (cronTimer <= 0) {
      cronTimer = cronEvery;
      pulses.cron = 1;
      events.push({ type: "cron" });
    }
    stats.cron = Math.max(0, cronTimer);
    rates.automation = (1.2 + pulses.cron * 6) * kAuto;
    rates.automationWrite = (0.8 + pulses.cron * 4) * kAuto * kWrite;
    bump("automation", rates.automation * 0.012);

    // --- crane (app builder)
    pulses.crane = Math.max(pulses.crane * 0.94, cfg.crane ? 1 : 0.12);

    // decay transient pulses
    pulses.checkpoint *= 0.86;
    pulses.barge = Math.max(0, pulses.barge - dt * 0.22);
    pulses.cron *= 0.8;
    pulses.founding *= 0.985;
    pulses.catchup *= 0.9;

    // decay district activity
    for (const k of DISTRICTS) activity[k] *= 0.9;
    // Harness Runtime Row goes dark while the rest of the city keeps working.
    if (harnessOff) {
      activity.runtime = 0;
      activity.consent = 0;
    }

    // window stats → per-second display, smoothed
    smooth.turns += (turnsWindow / dt - smooth.turns) * 0.12;
    smooth.items += (itemsWindow / dt - smooth.items) * 0.12;
    smooth.wal += (walWindow / dt - smooth.wal) * 0.12;
    turnsWindow = 0;
    itemsWindow = 0;
    walWindow = 0;
    stats.turns = smooth.turns;
    stats.items = smooth.items;
    stats.wal = smooth.wal;
  }

  function tick(dt: number): void {
    acc += Math.min(dt, 0.25);
    let guard = 0;
    while (acc >= TICK && guard++ < 8) {
      acc -= TICK;
      logic();
    }
  }

  return {
    stats,
    rates,
    pulses,
    activity,
    tick,
    setScenario,
    get scenario() {
      return scenarioId;
    },
    drainEvents() {
      const e = events.slice();
      events.length = 0;
      return e;
    },
  };
}
