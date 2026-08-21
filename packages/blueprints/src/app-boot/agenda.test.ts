// @vitest-environment jsdom
import { describeAppBoot } from "../app-boot-harness.ts";

// Agenda is held to the LIVE-READ journey: it paints from the local replica in
// airplane mode, keeps its held-write chip through a park and a denial over
// the production intent-invalidation derivation, and re-renders honestly when
// the grant is revoked and restored. See the harness header for why this app
// and Photos are the two that carry `expectLive`.
describeAppBoot("agenda", { expectLive: true });
