// First-run onboarding view. Mounted by app.ts when
// `settings.onboardingCompletedAt` is absent (a fresh install). Owns
// the root element while it's up; on completion the host re-renders
// home with the freshly-personalized profile in the sidebar.
//
// Why a dedicated view (vs. a modal over home):
//   - Home depends on the active gateway being personalized — the
//     sidebar's head row reads `displayName`, the switcher does too —
//     so showing home before onboarding leaks the auto-created
//     fallback label (e.g. "Local") into the chrome the user has to
//     scan past.
//   - First impressions matter. A welcome view sets a tone the rest
//     of the chrome can't (it's all dense utility surface).
//
// The view is intentionally a single step: a name + a color. The React
// OnboardingScreen owns the surface; this shim exposes it to the vanilla
// boot sequence through `window.Onboarding.mount`.

import { requireReactBridge } from './react/bridge.js';

(function () {
  function mount(opts: {
    root: HTMLElement;
    onComplete: (input: { displayName: string; avatarColor: string }) => Promise<void> | void;
  }): () => void {
    return requireReactBridge().mountOnboarding(opts.root, { onComplete: opts.onComplete });
  }

  window.Onboarding = { mount };
})();
