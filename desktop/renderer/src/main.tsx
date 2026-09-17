/*
 * The renderer (#1020).
 *
 * A thin client. It holds no credential, opens no socket and makes no network
 * call — every read is `window.CentraidApi.page(<a catalogue name>)` over the
 * preload's three-function bridge, and every blob is a `centraid://` URL main
 * answers in process. There is deliberately no `fetch` in this tree: a
 * bearer-carrying HTTP client against a loopback port is exactly what this
 * renderer must not be.
 *
 * The Tally and Photos screens are written here, over the same catalogue reads
 * as every other surface. Their parity is asserted, not assumed:
 * `renderer/src/apps/tally/fold.test.ts` compares this dashboard's fold against
 * `contracts/apps/tally/queries.json` case 0 field by field, and
 * `desktop/e2e/seat.e2e.ts` proves the same rows arrive from a real sidecar.
 */

import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const root = document.querySelector("#root");
if (!root) throw new Error("the shell document has no #root");
createRoot(root).render(React.createElement(App));
