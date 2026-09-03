export interface OpenBudget {
  maxRequests: number;
  maxTransferBytes: number;
}

export interface AppOpenBudget extends OpenBudget {
  maxEncodedBytes: number;
  minEncodedBytes: number;
  maxTotalRequests: number;
}

export interface ShellBudget extends OpenBudget {
  maxWarmToColdByteRatio: number;
}

export interface PerfBudgets {
  shell: ShellBudget;
  appOpen: {
    cold: AppOpenBudget;
    warm: AppOpenBudget;
    maxWarmToColdByteRatio: number;
  };
  swTunnelCache: {
    maxWarmToColdByteRatio: number;
    maxWarmToColdRequestRatio: number;
  };
  irohPool: {
    maxConnectToStreamRatio: number;
    minStreamsForProof: number;
  };
  timing: {
    coldOpenMsSoftCeiling: number;
    warmOpenMsSoftCeiling: number;
  };
}

export const approvedDeviation =
  "Binding Layer font fan-out re-baseline in #707/#708/#709. CI web-e2e on PR #709 head 88ab442f measured cold same-origin shell requests=16 transfer=495485B (PWA WATERFALL SUMMARY). The +4 requests / +~74 KB vs the prior 12 / 470_000 ceilings were the ten self-hosted woff2 faces served from /fonts by the centraid-fonts Vite plugin; they are intentional product identity, not accidental chunk bloat. v8 cuts that fan-out to FOUR files (Instrument Sans 400/600, latin + latin-ext); Source Serif 4 and the 500 cut are withdrawn, numerics remain tabular Sans, and code takes the platform stack, which downloads nothing. The ceilings below are NOT re-baselined here, because they are measured in CI rather than derived: the next web-e2e run should measure the smaller payload before this ratchet is tightened. Prior Vite 8 note (#565) still holds for JS chunking: going below the JS half still needs a web-host.ts source change. maxRequests widens 12 -> 17 (measured 16 + 1); maxTransferBytes widens 470_000 -> 520_000 (measured 495_485 + ~5% headroom). #738 adds the durable pending-write read/presentation engine to the common shell; PR #745 CI measured 525304B before its replacement path was split behind retry/edit. Maintainer-approved maxTransferBytes 520_000 -> 528_000 preserves a 2696B ceiling above that measured run while keeping request count and all app-open/warm budgets unchanged. Tighten when the shared pending metadata grammar or font payload is reduced. #799 stage 2 RE-SEEDS the appOpen budgets, because the subject changed rather than regressed: the served-app iframe is deleted, so an app open is now a dynamic import of an inline route's lazy chunk inside the shell window, measured as the same-origin tail of the shell's own resource timeline. Measured (local `bun run --cwd apps/web build` dist, headless Chromium, 2026-08-15) opening Tasks: cold 8-9 requests / 0 transfer B / 112_759 encoded B, warm 0 requests / 0 B. Two ceilings WIDEN and are the whole of the deviation: appOpen.cold.maxRequests 8 -> 10 (the old 8 fenced a fixture iframe with ZERO subresources; the inline route legitimately pulls eight same-origin chunks, plus a ninth worker entry that races the mark) and, structurally, the byte fence moves onto a new `maxEncodedBytes` key (120_000 cold) because `transferSize` is 0 for anything the service worker answers from Cache Storage and so can no longer fence weight at all. Everything else TIGHTENS in the same edit: appOpen.warm.maxRequests 8 -> 2, both maxTransferBytes 20_000 -> 8_000 (measured 0; the ceiling now fences 'an open must not go back to the network'), and maxWarmToColdByteRatio 1.2 -> 0.1 (the 1.2 existed only because the retired app document was no-store and re-transferred in full every open). DISCLOSE THE SCOPE CHANGE, because the ratchet cannot see it: main asserted app-open requests and bytes over ALL origins; the re-pointed spec asserts them over SAME-ORIGIN only. warm.maxRequests 8 -> 2 and both maxTransferBytes 20_000 -> 8_000 are therefore measured against a strictly smaller population, so they are not the pure tightenings their numbers suggest. Same-origin is the right subject (the harness gateway answers on another port with no Timing-Allow-Origin header, so every control/replica/query call reports 0 bytes and would dilute the total), but it would have left cross-origin traffic unfenced entirely, so a new maxTotalRequests key gates the ALL-ORIGIN count instead: cold 30, warm 14, from measured 20-24 and 6-9 over 13 runs. Cross-origin BYTES remain unfenced and unfenceable in this harness; that is a known limit of the rig, not a budget decision. A new minEncodedBytes floor (cold 90_000, an up-only ratchet) replaces the bare '> 0' anti-vacuity check, which fenced only exactly-zero and so would not have caught the realistic failure — the app chunk getting preloaded or folded into `boot`, leaving one incidental byte in the window while every ceiling passed. The mark is now taken after the palette's own chunks settle: without that, cold read 112_759 B with an occasional 179_759 B outlier as an in-flight palette chunk was charged to the app open. Re-measure and tighten maxEncodedBytes when the shared inline chunk graph shrinks. #800 re-seeds minEncodedBytes 90_000 -> 70_000 from CI linux web-e2e on PR #800 run 31921007894 (head 3122163cd): cold same-origin encoded=80561 B on both the first run and retry, while the 90_000 floor was taken from a local darwin 112_759 B measurement. 70_000 sits ~13% under the CI number — still well above an incidental byte or a missing app-inline chunk (~52 KB) — so the anti-vacuity check stays load-bearing. The 120_000 ceiling is unchanged.";

export const perfBudgets: PerfBudgets = {
  shell: {
    maxRequests: 17,
    maxTransferBytes: 528_000,
    maxWarmToColdByteRatio: 0.15,
  },
  appOpen: {
    cold: {
      maxRequests: 10,
      maxTransferBytes: 8_000,
      maxEncodedBytes: 120_000,
      minEncodedBytes: 70_000,
      maxTotalRequests: 30,
    },
    warm: {
      maxRequests: 2,
      maxTransferBytes: 8_000,
      maxEncodedBytes: 8_000,
      minEncodedBytes: 0,
      maxTotalRequests: 14,
    },
    maxWarmToColdByteRatio: 0.1,
  },
  swTunnelCache: {
    maxWarmToColdByteRatio: 0.2,
    maxWarmToColdRequestRatio: 1,
  },
  irohPool: {
    maxConnectToStreamRatio: 0.5,
    minStreamsForProof: 3,
  },
  timing: {
    coldOpenMsSoftCeiling: 15_000,
    warmOpenMsSoftCeiling: 8_000,
  },
};

export const enforceTiming = true;
