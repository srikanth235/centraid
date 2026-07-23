// Tally — served entry. A thin adapter that mounts the shared query-free
// `Root` (app-root.tsx) for the served/WebView transport. The imperative
// createRoot-islands version this file used to be was retired in favour of the
// single React tree the shell renders inline (issue #505): keeping two parallel
// mounts meant every handler, board-prop and refresh path lived in two places.
// Now there is one source of truth — `Root` — and this entry just renders it
// into the served page's root node so the gateway's `/centraid/<id>/` route
// (mobile WebViews, until they move to the native Expo client) shows the same UI
// the shell does. It imports `Root` from app-root.tsx (not the app-inline
// descriptor) so the served bundle never pulls in the node-side `./queries/*`
// modules. `window.centraid` is provided by the served runtime, exactly as the
// inline shell installs it, so `Root` needs nothing extra here.
import { createRoot } from './react-core.min.js';
import { Root } from './app-root.tsx';

const host = document.getElementById('appRoot');
if (host) {
  createRoot(host).render(<Root rootRef={() => {}} />);
}
