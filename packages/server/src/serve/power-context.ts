/*
 * Host power-context posture (#528) — courtesy & energy, NEVER a silent
 * durable mode flip. Reports battery/mains/server and whether a courteous
 * gateway should DEFER (not stop) safe background loops. Same gate as the
 * owner's pause and event-loop load-shed. Never writes prefs, never flips
 * Resource mode, never mutates pause state.
 *
 * Two feeds: BOOT PROBE (os-probe, ≤60s) establishes battery PRESENCE;
 * CLIENT PUSH (Electron, stale after 120s) is fresher. No timer of its own —
 * snapshot() lazily re-evaluates.
 */

import { execFile } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";

export type PowerContextKind = "battery" | "mains" | "server";
export type ThermalPressure = "nominal" | "fair" | "serious" | "critical";

export interface PowerContextState {
  kind: PowerContextKind;
  /** null when the host has no battery — this null gates ALL battery chrome in the UI */
  battery: { percent: number | null; charging: boolean | null } | null;
  deferringBackgroundWork: boolean;
  reason: "on-battery" | "low-battery" | "thermal" | null;
  source: "os-probe" | "client-push" | "none";
  stealPercent: number | null;
  updatedAt: number | null;
}

export interface PowerContextPushBody {
  onBattery: boolean;
  batteryPercent?: number | null;
  charging?: boolean | null;
  thermalPressure?: ThermalPressure | null;
}

/** `present:false` means "no battery on this host". */
export interface BatteryProbeResult {
  present: boolean;
  percent: number | null;
  charging: boolean | null;
  discharging: boolean | null;
}

export interface CpuStealSample {
  steal: number;
  total: number;
}

const PERCENT_LOW_FLOOR = 20;
const CLIENT_PUSH_STALE_MS = 120_000;
const READ_REFRESH_MS = 60_000;

/**
 * Pure posture (#528). Single `reason`, precedence low-battery > thermal >
 * on-battery. `reason:null` never defers. `battery` is null exactly when no
 * battery is present — the UI's gate.
 */
export function evaluatePosture(input: {
  platform: NodeJS.Platform;
  hasBattery: boolean;
  percent: number | null;
  charging: boolean | null;
  discharging: boolean | null;
  thermalPressure: ThermalPressure | null;
  stealPercent: number | null;
  source: PowerContextState["source"];
  updatedAt: number | null;
}): PowerContextState {
  const kind: PowerContextKind = input.hasBattery
    ? input.discharging === true
      ? "battery"
      : "mains"
    : input.platform === "linux"
      ? "server"
      : "mains";

  const thermalStressed =
    input.thermalPressure === "serious" || input.thermalPressure === "critical";
  let reason: PowerContextState["reason"] = null;
  if (
    input.discharging === true &&
    input.percent !== null &&
    input.percent < PERCENT_LOW_FLOOR
  ) {
    reason = "low-battery";
  } else if (thermalStressed) {
    reason = "thermal";
  } else if (input.discharging === true) {
    reason = "on-battery";
  }

  return {
    kind,
    battery: input.hasBattery
      ? { percent: input.percent, charging: input.charging }
      : null,
    deferringBackgroundWork: reason !== null,
    reason,
    source: input.source,
    stealPercent: input.stealPercent,
    updatedAt: input.updatedAt,
  };
}

/** Failure-tolerant: resolves `null` on any error/unknown platform. */
export async function defaultBatteryProbe(
  platform: NodeJS.Platform
): Promise<BatteryProbeResult | null> {
  try {
    if (platform === "darwin") return parsePmset(await runPmset());
    if (platform === "linux") return await readLinuxBattery();
  } catch {
    return null;
  }
  return null;
}

function runPmset(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("pmset", ["-g", "batt"], { timeout: 2_000 }, (err, stdout) => {
      if (err) reject(new Error(err.message, { cause: err }));
      else resolve(stdout);
    });
  });
}

/** Parse `pmset -g batt`. No `InternalBattery` line ⇒ a desktop Mac (no battery). */
export function parsePmset(out: string): BatteryProbeResult {
  if (!/-InternalBattery-/u.test(out)) {
    return { present: false, percent: null, charging: null, discharging: null };
  }
  const percentMatch = out.match(/(?<percent>\d+)%/u);
  const percent = percentMatch ? Number(percentMatch.groups?.percent) : null;
  const onBattery =
    /'Battery Power'/u.test(out) || /;\s*discharging/u.test(out);
  const charging =
    /'AC Power'/u.test(out) || /;\s*(?:charging|charged)/u.test(out);
  return {
    present: true,
    percent,
    charging: charging && !onBattery,
    discharging: onBattery,
  };
}

async function readLinuxBattery(): Promise<BatteryProbeResult | null> {
  const base = "/sys/class/power_supply";
  let names: string[];
  try {
    names = await fs.readdir(base);
  } catch {
    return null;
  }
  const findBattery = async (index: number): Promise<BatteryProbeResult> => {
    const name = names[index];
    if (name === undefined) {
      return {
        present: false,
        percent: null,
        charging: null,
        discharging: null,
      };
    }
    let type: string;
    try {
      type = (await fs.readFile(`${base}/${name}/type`, "utf8")).trim();
    } catch {
      return findBattery(index + 1);
    }
    if (type !== "Battery") return findBattery(index + 1);
    const capacity = await readNumberFile(`${base}/${name}/capacity`);
    const status = (await readTextFile(`${base}/${name}/status`))?.trim();
    return {
      present: true,
      percent: capacity,
      charging:
        status === null ? null : status === "Charging" || status === "Full",
      discharging: status === null ? null : status === "Discharging",
    };
  };
  return findBattery(0);
}

async function readNumberFile(path: string): Promise<number | null> {
  const text = await readTextFile(path);
  const n = text === null ? NaN : Number(text.trim());
  return Number.isFinite(n) ? n : null;
}

async function readTextFile(path: string): Promise<string | null> {
  return fs.readFile(path, "utf8").catch(() => null);
}

/** Default linux steal sampler — the `cpu ` aggregate line of `/proc/stat`. */
export function defaultStealSampler(
  platform: NodeJS.Platform
): () => CpuStealSample | null {
  if (platform !== "linux") return () => null;
  return () => {
    try {
      const line = readFileSync("/proc/stat", "utf8")
        .split("\n")
        .find((l) => l.startsWith("cpu "));
      if (!line) return null;
      const cols = line.trim().split(/\s+/u).slice(1).map(Number);
      if (cols.length < 8 || cols.some((n) => !Number.isFinite(n))) return null;
      const total = cols.reduce((a, b) => a + b, 0);
      return { steal: cols[7] ?? 0, total };
    } catch {
      return null;
    }
  };
}

export interface PowerContextMonitorOptions {
  platform?: NodeJS.Platform;
  now?: () => number;
  probeBattery?: (
    platform: NodeJS.Platform
  ) => Promise<BatteryProbeResult | null>;
  readStealSample?: () => CpuStealSample | null;
  /** Fired when the deferring bit toggles (or first becomes true) — never on the boring boot false. */
  onDeferringChange?: (state: PowerContextState) => void;
}

/**
 * Boot probe + client-push, assembled on demand. No timer of its own.
 * Failure-tolerant — a missing probe leaves the posture at `none`.
 */
export class PowerContextMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly probeBattery: (
    p: NodeJS.Platform
  ) => Promise<BatteryProbeResult | null>;
  private readonly readStealSample: () => CpuStealSample | null;
  private readonly onDeferringChange?: (state: PowerContextState) => void;

  private clientPush?: {
    onBattery: boolean;
    percent: number | null;
    charging: boolean | null;
    thermalPressure: ThermalPressure | null;
    atMs: number;
  };
  private bootProbe: BatteryProbeResult | null = null;
  private bootProbeDone = false;
  private bootProbeOk = false;
  private batteryReadAtMs?: number;
  private refreshing = false;
  private stealPercent: number | null = null;
  private lastStealSample?: CpuStealSample;
  private stealReadAtMs?: number;
  private lastDeferring?: boolean;
  readonly ready: Promise<void>;

  constructor(options: PowerContextMonitorOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.probeBattery = options.probeBattery ?? defaultBatteryProbe;
    this.readStealSample =
      options.readStealSample ?? defaultStealSampler(this.platform);
    if (options.onDeferringChange)
      this.onDeferringChange = options.onDeferringChange;
    this.ready = this.refreshBattery(this.now());
  }

  applyClientPush(body: PowerContextPushBody): void {
    this.clientPush = {
      onBattery: body.onBattery,
      percent: body.batteryPercent ?? null,
      charging: body.charging ?? null,
      thermalPressure: body.thermalPressure ?? null,
      atMs: this.now(),
    };
  }

  clearClientPush(): void {
    this.clientPush = undefined;
  }

  isDeferringBackgroundWork(): boolean {
    return this.snapshot().deferringBackgroundWork;
  }

  snapshot(): PowerContextState {
    const now = this.now();
    const stale =
      this.batteryReadAtMs === undefined ||
      now - this.batteryReadAtMs >= READ_REFRESH_MS;
    if (!this.refreshing && stale) void this.refreshBattery(now);
    this.refreshSteal(now);

    const push =
      this.clientPush && now - this.clientPush.atMs <= CLIENT_PUSH_STALE_MS
        ? this.clientPush
        : undefined;

    let hasBattery: boolean;
    if (this.bootProbeDone && this.bootProbeOk) {
      hasBattery = this.bootProbe?.present ?? false;
    } else if (push) {
      hasBattery = push.onBattery === true || push.percent !== null;
    } else {
      hasBattery = false;
    }

    let percent: number | null;
    let charging: boolean | null;
    let discharging: boolean | null;
    let thermalPressure: ThermalPressure | null;
    if (push) {
      discharging = push.onBattery;
      charging = push.charging ?? (push.onBattery ? false : null);
      percent = push.percent ?? this.bootProbe?.percent ?? null;
      thermalPressure = push.thermalPressure;
    } else if (this.bootProbe?.present) {
      discharging = this.bootProbe.discharging;
      charging = this.bootProbe.charging;
      percent = this.bootProbe.percent;
      thermalPressure = null;
    } else {
      discharging = null;
      charging = null;
      percent = null;
      thermalPressure = null;
    }

    const source: PowerContextState["source"] = push
      ? "client-push"
      : this.bootProbeDone && this.bootProbeOk
        ? "os-probe"
        : "none";
    const updatedAt = push
      ? push.atMs
      : source === "os-probe"
        ? (this.batteryReadAtMs ?? null)
        : null;

    const state = evaluatePosture({
      platform: this.platform,
      hasBattery,
      percent,
      charging,
      discharging,
      thermalPressure,
      stealPercent: this.stealPercent,
      source,
      updatedAt,
    });

    if (this.lastDeferring !== state.deferringBackgroundWork) {
      if (
        !(
          this.lastDeferring === undefined &&
          state.deferringBackgroundWork === false
        )
      ) {
        this.onDeferringChange?.(state);
      }
      this.lastDeferring = state.deferringBackgroundWork;
    }
    return state;
  }

  private async refreshBattery(now: number): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      this.bootProbe = await this.probeBattery(this.platform);
      this.bootProbeOk = true;
    } catch {
      this.bootProbeOk ||= false;
    } finally {
      this.bootProbeDone = true;
      this.batteryReadAtMs = now;
      this.refreshing = false;
    }
  }

  private refreshSteal(now: number): void {
    if (this.platform !== "linux") {
      this.stealPercent = null;
      return;
    }
    if (
      this.stealReadAtMs !== undefined &&
      now - this.stealReadAtMs < READ_REFRESH_MS
    )
      return;
    const sample = this.readStealSample();
    this.stealReadAtMs = now;
    if (!sample) return;
    if (this.lastStealSample) {
      const dTotal = sample.total - this.lastStealSample.total;
      const dSteal = sample.steal - this.lastStealSample.steal;
      if (dTotal > 0) {
        this.stealPercent = Math.max(0, Math.min(100, (dSteal / dTotal) * 100));
      }
    }
    this.lastStealSample = sample;
  }
}
