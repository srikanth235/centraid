/**
 * Renderer leak budgets (#842; per-app overrides added in #883 C1).
 *
 * SHAPE OF THIS FILE. The top-level numbers are the DISCIPLINE budgets — what
 * a well-behaved app open/close is held to, derived once from the argument
 * below and applied to every app the lane measures. `perApp` is an OVERRIDE
 * REGISTER in the sense of `docs/design-divergences.md`: an entry there is a
 * known, named, dated deviation with a shrinker on the hook for it, not a
 * second opinion about what discipline means. An app with no entry is held to
 * the discipline numbers, which is the case that should stay overwhelmingly
 * common.
 *
 * A leak lane needs an objective threshold, and "the number looked stable" is
 * not one. Every ceiling below is derived from ONE argument, stated once here
 * and cited by each entry:
 *
 *   THE PER-CYCLE-RESIDUE ARGUMENT
 *   The measured quantity is a census over N identical open/close cycles of
 *   the SAME app in the SAME document, taken after a warm-up that absorbs
 *   one-time allocation (lazy chunks, singletons, the replica's first lease).
 *   Every counter here is an integer over a repeated, idempotent cycle, so a
 *   leak-free renderer returns to its post-warm-up census exactly. A leak, by
 *   contrast, leaves a residue r ≥ 1 per cycle and therefore ≥ N over the
 *   window. Setting each ceiling STRICTLY BELOW N is what makes the two cases
 *   mechanically distinguishable: no per-cycle residue can hide under a
 *   ceiling smaller than the number of cycles, while a one-off allocation on
 *   some later cycle still passes.
 *
 * That is why these are absolute totals over the whole window rather than
 * per-cycle rates: a per-cycle rate would have to be fractional, and a
 * fractional ceiling on an integer counter is a ceiling nobody can reason
 * about.
 *
 * Tighten-only, like every other budget file in the suite (TESTING.md §
 * "Floors ratchet"): a ceiling may drop freely, and widening one is a reviewed
 * edit that must record what the extra slack buys.
 */

export const leakBudgets = {
  /**
   * Cycles thrown away before the first census. Three is enough to cover the
   * one-time costs an open pays exactly once — the route's lazy chunk, the
   * inline bridge, the replica lease, the first render of every singleton —
   * and cheap enough that the lane stays inside its Playwright timeout.
   */
  warmupCycles: 3,

  /**
   * Cycles measured. Every ceiling below is < this number by construction (see
   * the per-cycle-residue argument above), so raising it only ever makes the
   * lane stricter in relative terms.
   */
  measuredCycles: 12,

  /**
   * INTEGRAL counters: a subscription is either torn down or it is not, so
   * there is no measurement noise to absorb and the ceiling is zero. These are
   * the highest-signal numbers in the file — an `EventSource` or an interval
   * surviving an app close is a leak with no benign explanation.
   */
  maxIntervalGrowth: 0,
  maxEventSourceGrowth: 0,
  maxObserverGrowth: 0,

  /**
   * Listener registrations on `window` / `document` / `body` — the three
   * targets that survive a route swap. 2 over 12 cycles is 0.17 per cycle:
   * below one, so no per-cycle residue fits under it, while a single late
   * singleton (a lazily-installed shortcut handler) still passes.
   */
  maxListenerGrowth: 2,

  /**
   * Elements attached to the document. Same 2-over-12 reasoning; the shell
   * legitimately keeps a portal root or a live-region node around, and those
   * are created once rather than per cycle.
   */
  maxDomNodeGrowth: 2,

  /**
   * CHROMIUM ONLY, over CDP, after a forced `HeapProfiler.collectGarbage`:
   * the renderer's total node count including nodes no longer in the document.
   * A DETACHED subtree that JS still references survives that GC and shows up
   * here and nowhere else — this is the only number in the file that can see
   * the classic detached-DOM leak at all. Same argument, looser number: 6 over
   * 12 cycles is 0.5 per cycle, still strictly below one, so
   * no per-cycle residue fits under it. MEASURED 2026-08-21 on the rig below:
   * +3, which is GC nondeterminism rather than retention (the page-side census
   * over the same window is flat), and the ceiling is that measurement plus
   * one doubling of headroom.
   */
  maxRetainedNodeGrowth: 6,

  /**
   * CHROMIUM ONLY, post-GC JS heap. The one NON-integral quantity here, so the
   * residue argument does not apply and the ceiling cannot be derived the same
   * way: V8 keeps allocation-site feedback, JIT code and GC bookkeeping that
   * grow with execution rather than with retention, and `collectGarbage` is a
   * best-effort request rather than a proof of quiescence.
   *
   * It is expressed as a RATIO of the post-warm-up heap so it scales with the
   * shell rather than pinning a byte count that a bundling change invalidates.
   * MEASURED 2026-08-21 (linux x64, Playwright bundled headless Chromium, this
   * lane at 3 + 12 cycles): 0.1053 — 6.13 MB → 6.77 MB. The ceiling is that
   * measurement roughly tripled, because it is a BACKSTOP for a gross
   * retention leak rather than a fence on ordinary heap movement: the integral
   * counters above are what make the fine-grained claim, and a heap ceiling
   * tight enough to flake on JIT warm-up would only teach agents to widen it.
   */
  maxHeapGrowthRatio: 0.35,

  /**
   * Anti-vacuity floor: elements INSIDE the mounted app view, on the worst
   * cycle of the run. A cycle that mounted nothing would hold every ceiling
   * above at zero and report a perfect result, so the census has to testify
   * that an app was really rendered each time.
   *
   * Deliberately the app's own subtree rather than a whole-document delta.
   * MEASURED 2026-08-21: a document-total delta reads +11 when this lane runs
   * alone and 0 in a full-suite run, because Home's own content grows with
   * whatever earlier specs wrote to the shared harness vault — a witness that
   * depends on suite order is not a witness. The subtree count is a property
   * of the app alone; measured at 44 elements, and the floor is set well under
   * it so a copy change cannot red the lane while an empty route still does.
   */
  minMountedSubtreeNodes: 5,

  /**
   * PER-APP OVERRIDES. Empty is the goal state; every entry is debt with a named
   * shrinker, and every entry must say what it observed, when, and who is on the
   * hook to remove it. Ratcheted tighten-only with the rest of this file
   * (`PERF_BUDGET_SOURCES`), so an override may shrink freely and widening one is
   * a reviewed edit — which is exactly the pressure that keeps this register from
   * becoming the place ceilings go to die.
   */
  perApp: {
    /**
     * PHOTOS — THE DEBT IS PAID (#883 C4). This entry is no longer an override
     * in the sense the register above describes: both numbers now sit AT OR
     * BELOW the discipline ceilings, so Photos is held to the same standard as
     * every other app and then some.
     *
     * WHAT WAS HERE. Seeded by #883 C1 as measured debt: `maxListenerGrowth`
     * 60 and `maxRetainedNodeGrowth` 9,500, both admitted at the time to defeat
     * the per-cycle-residue argument by construction — rate pins on a leak
     * already found, not detectors. The measurement behind them, on this lane
     * at 3 + 12 cycles:
     *
     *                       BEFORE                AFTER
     *   listeners           33 → 93   (+60)       18 → 18   (+0)
     *   retained            2,979 → 11,292        1,609 → 1,609
     *                                 (+8,313)              (+0)
     *   domNodes            196 → 195  (-1)       199 → 199 (+0)
     *   heapRatio           0.2824 / 0.2943       0.1456
     *
     * Tasks in the same AFTER session: listeners 18 → 18, retained 856 → 856,
     * heapRatio 0.0978. The two apps now read alike on every counter, which is
     * the contrast the C1 note said would settle the question.
     *
     * THE CAUSE, since it is worth stating where the number was pinned.
     * `apps/photos/upload.ts` `wireUpload` installed five `window` listeners —
     * dragenter, dragover, dragleave, drop, paste — and returned `void`, so
     * nothing ever removed them: exactly the residue r=5 per cycle the listener
     * count reported. The ~693 retained nodes per cycle were the same defect
     * seen from the heap: each handler closed over `uploadFiles` and
     * `openPicker`, which close over the app root's store, its asset arrays and
     * its React roots, so every closed Photos stayed reachable from `window`
     * and its whole detached subtree survived the forced
     * `HeapProfiler.collectGarbage`. `wireUpload` now returns a disposer the
     * app root unwinds, the media lookahead's observers are torn down with
     * `stopMediaObservation()`, and the justified timeline is windowed so the
     * detached tree is a viewport rather than a library.
     *
     * WHY THE KEYS STAY RATHER THAN THE BLOCK BEING DELETED. The tighten-only
     * ratchet (`scripts/test-report/ratchet-floors.mjs`) reads REMOVAL OF A KEY
     * AS A WIDEN, and it is right to: it cannot tell "this app no longer needs
     * an override" from "somebody deleted the ceiling that was failing". So the
     * entry stays and the numbers come down to where the measurement puts them.
     */
    Photos: {
      /**
       * ZERO, from +60. The listener census is integral and bit-exact — a
       * registration is live or it is not — and the AFTER run measured +0, so
       * there is nothing for headroom to absorb. Stricter than the discipline
       * ceiling of 2 on purpose: 2 exists to let a lazily-installed shell
       * singleton through on ANY app, and this app is the one that has just
       * been proved to install none.
       */
      maxListenerGrowth: 0,
      /**
       * The discipline ceiling, from +9,500. Measured +0, repeatedly — and the
       * repeatability was itself earned: the census used to be BIMODAL, reading
       * +0 on most runs and one whole app view (+73, +79) on the rest, because
       * a single forced sweep left the last cycle's detached tree behind. The
       * lane now sweeps twice with a beat between them (`renderer-leak.spec.ts`
       * `heapCensus`) and reads exactly +0 run after run.
       *
       * Pinned at the discipline number rather than at the measurement, and
       * that is a deliberate stop. 6 over 12 cycles is 0.5 per cycle — strictly
       * below one, so no per-cycle residue can hide under it, which is the
       * property the whole file is built on. Below that the ceiling would be
       * buying nothing the argument does not already give, at the cost of
       * reddening the lane on a rig whose GC behaves slightly differently.
       * Held here rather than deleted for the reason above.
       */
      maxRetainedNodeGrowth: 6,
      // Still not overridden, and now for the ordinary reason: Photos passes
      // domNodes (+0), intervals (+0), eventSources (+0), observers (+0) and
      // heapGrowthRatio (0.1407, beside Tasks' 0.1201) on the discipline
      // numbers alone.
    },
  },
} as const;

/**
 * The ceiling half of {@link leakBudgets} — everything except the cycle counts,
 * which are rig shape rather than a budget, and the override register itself.
 * Widened from the `as const` literal types to plain `number` so an override
 * can carry a different value; the tighten-only ratchet, not the type system,
 * is what stops one from growing.
 */
export type LeakCeilings = Record<
  Exclude<
    keyof typeof leakBudgets,
    "warmupCycles" | "measuredCycles" | "perApp"
  >,
  number
>;

/**
 * The ceilings a given app is held to: the discipline numbers, with any entry
 * from `leakBudgets.perApp` laid over them. Keys are listed explicitly rather
 * than spread, so adding a ceiling above without deciding whether it is
 * per-app-overridable is a compile error rather than a silent omission.
 */
export function budgetsForApp(appName: string): LeakCeilings {
  const overrides: Partial<LeakCeilings> =
    (leakBudgets.perApp as Record<string, Partial<LeakCeilings>>)[appName] ??
    {};
  return {
    maxIntervalGrowth: leakBudgets.maxIntervalGrowth,
    maxEventSourceGrowth: leakBudgets.maxEventSourceGrowth,
    maxObserverGrowth: leakBudgets.maxObserverGrowth,
    maxListenerGrowth: leakBudgets.maxListenerGrowth,
    maxDomNodeGrowth: leakBudgets.maxDomNodeGrowth,
    maxRetainedNodeGrowth: leakBudgets.maxRetainedNodeGrowth,
    maxHeapGrowthRatio: leakBudgets.maxHeapGrowthRatio,
    minMountedSubtreeNodes: leakBudgets.minMountedSubtreeNodes,
    ...overrides,
  };
}
