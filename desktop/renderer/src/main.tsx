/*
 * The renderer (#1020 wave 3 lane F).
 *
 * A thin client. It holds no credential, opens no socket and makes no network
 * call — every read is `window.CentraidApi.page(<a catalogue name>)` over the
 * preload's three-function bridge, and every blob is a `centraid://` URL main
 * answers in process. There is deliberately no `fetch` in this tree, which is
 * the difference from v0's renderer (a bearer-carrying HTTP client against a
 * loopback port, census §F5).
 *
 * ## What is here, and what is a hand-off
 *
 * D-1020-F5 asks for Tally and Photos **mounted from
 * `packages/blueprints/apps/{tally,photos}/app-inline`**. Those components take
 * v0's `@centraid/client` context — a gateway HTTP client, an SSE change feed,
 * and the design-token provider — so mounting them means adapting that context
 * rather than adapting a data source, and the adapter is a piece of work the
 * size of this renderer. So this wave ships the **screens** over the same
 * reads, and the mount is a named hand-off (see `desktop/README.md`). The
 * parity claim is not deferred with it: `renderer/src/apps/tally/fold.test.ts`
 * compares this dashboard's fold against `contracts/apps/tally/queries.json`
 * case 0 field by field, and `desktop/e2e/seat.spec.ts` proves the same rows
 * arrive from a real sidecar.
 */

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const root = document.querySelector("#root");
if (!root) throw new Error("the shell document has no #root");
createRoot(root).render(React.createElement(App));
