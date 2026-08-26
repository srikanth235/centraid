/**
 * Renderer leak budgets (#842).
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
} as const;
