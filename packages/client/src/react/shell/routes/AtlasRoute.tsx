import type { JSX } from 'react';
import { vaultAtlasGraph, vaultAtlasPulse, vaultAtlasStats } from '../../../gateway-client.js';
import AtlasScreen from '../../screens/AtlasScreen.js';
import PageScroll from '../PageScroll.js';

// React-owned Vault Atlas route (issue #441 Part B) — the ontology-at-a-glance
// census that lives under the sidebar's Operations section. Thin like
// BackupsRoute: it hands the three read-only census loaders straight to the
// screen, which owns its own head, tab strip, and per-tab loading/error states
// (there's no runtime snapshot to gate on here). The screen carries its own
// title + tabs, so PageScroll wraps it headless — same as GatewayRoute.
export default function AtlasRoute(): JSX.Element {
  return (
    <PageScroll>
      <AtlasScreen
        loadStats={vaultAtlasStats}
        loadPulse={vaultAtlasPulse}
        loadGraph={vaultAtlasGraph}
      />
    </PageScroll>
  );
}
